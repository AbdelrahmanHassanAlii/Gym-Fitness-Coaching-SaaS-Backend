# V1 File and Document Integration Guide

Issue: V1-FE-08 / GitHub #13

Locked baseline: `d2fb55b2f9b7a7775e0b9072835aed9e4b2831f3`

Backend root inspected: `apps/backend`

## Source Of Truth

The locked Stage 18 backend implementation is authoritative over generated
OpenAPI, previous summaries, and this document. Route files, schemas, services,
repositories, tests, migrations, and existing V1 docs win when they disagree with
generated artifacts.

This guide is frontend-facing. It documents the implemented V1 file/document
lifecycle only. It does not change file services, storage providers, schemas,
migrations, tests, quotas, OpenAPI, permissions, or runtime behavior.

## Evidence Used

- `src/modules/files/file.routes.ts`
- `src/modules/files/file.schemas.ts`
- `src/modules/files/file.service.ts`
- `src/modules/files/file.repository.ts`
- `src/modules/files/file.types.ts`
- `src/modules/files/file.jobs.ts`
- `src/core/storage/storage.provider.ts`
- `src/core/storage/s3-storage.provider.ts`
- `src/core/storage/fake-storage.provider.ts`
- `src/modules/subscriptions/subscription.service.ts`
- `src/modules/subscriptions/subscription.repository.ts`
- `src/modules/permissions/permission.registry.ts`
- `src/modules/support-access/support-access.service.ts`
- `src/migrations/018-stage13-files-documents.ts`
- `test/stage13-files-documents.test.ts`
- `test/stage16-support-access.test.ts`
- `docs/v1/frontend-api-integration-guide.md`
- `docs/v1/frontend-pagination-cursor-contract.md`
- `docs/v1/frontend-error-ux-catalog.md`
- `docs/v1/frontend-timezone-analytics-contract.md`

## Contract Summary

The V1 file lifecycle is split between backend API calls and direct object
storage calls:

1. Create an upload intent through the backend.
2. Upload the binary object directly to the returned storage URL.
3. Confirm the upload intent through the backend.
4. Optionally create relationship document metadata that links the confirmed
   file to a coaching relationship.
5. Request a short-lived download URL through the backend when the user wants to
   download the file.
6. Delete/restore files and delete documents through backend commands with
   `expectedVersion`.

The backend stores file metadata and document metadata separately. A file is the
stored object. A document is relationship-scoped business metadata that points at
one file. A file can be confirmed without a document; a document cannot exist
without an active, user-uploaded file in the same relationship.

## Route Inventory

| Method | Path | Purpose | Idempotency | Body/query |
| --- | --- | --- | --- | --- |
| `POST` | `/api/v1/workspaces/:workspaceId/files/upload-intents` | Reserve storage quota and create a direct-upload URL. | Required by route wrapper. | `UploadIntentBody` |
| `POST` | `/api/v1/workspaces/:workspaceId/files/upload-intents/:uploadIntentId/confirm` | Verify object metadata through storage HEAD and create active file metadata. | Required by route wrapper. | `{ expectedVersion }` |
| `POST` | `/api/v1/workspaces/:workspaceId/files/:fileId/download-url` | Issue a short-lived direct download URL. | No. | none |
| `DELETE` | `/api/v1/workspaces/:workspaceId/files/:fileId` | Soft-delete a user-uploaded active file. | Required by route wrapper. | `{ expectedVersion }` |
| `POST` | `/api/v1/workspaces/:workspaceId/files/:fileId/restore` | Restore a soft-deleted file before purge eligibility. | Required by route wrapper. | `{ expectedVersion }` |
| `GET` | `/api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents` | List active documents for a relationship. | No. | `cursor`, `limit` |
| `POST` | `/api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents` | Attach document metadata to a confirmed file. | Required by route wrapper. | `CreateDocumentBody` |
| `GET` | `/api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents/:documentId` | Read one active document. | No. | none |
| `DELETE` | `/api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents/:documentId` | Soft-delete document metadata and soft-delete its active file. | Required by route wrapper. | `{ expectedVersion }` |

Idempotent routes must send `Idempotency-Key` for user commands. Reuse a key
only for an exact retry of the same request body/path.

## Upload Intent

Request body:

```json
{
  "purpose": "DOCUMENT",
  "subjectType": "COACHING_RELATIONSHIP",
  "subjectId": "relationshipId",
  "fileName": "plan.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 500,
  "checksumSha256": "optional-64-char-lower-or-uppercase-hex",
  "classification": "STANDARD",
  "sensitive": false
}
```

Allowed values:

| Field | Implemented values |
| --- | --- |
| `purpose` | `DOCUMENT`, `PROGRESS_PHOTO`, `GENERIC` |
| `subjectType` | `COACHING_RELATIONSHIP`, `WORKSPACE` |
| `classification` | `STANDARD`, `SENSITIVE` |
| MIME types | `application/pdf`, `image/jpeg`, `image/png`, `image/webp` |
| Maximum upload size | 200 MiB |

Response body is wrapped by the idempotency route as `{ data: ... }`:

```json
{
  "data": {
    "uploadIntentId": "intentId",
    "uploadUrl": "https://...",
    "expiresAt": "2026-01-01T00:15:00.000Z",
    "uploadUrlExpiresAt": "2026-01-01T00:10:00.000Z",
    "reservedBytes": 500,
    "expectedVersion": 0
  }
}
```

Implementation behavior:

- Upload intent TTL is 15 minutes.
- Upload URL TTL is 10 minutes, capped by the intent expiry.
- `reservedBytes` equals requested `sizeBytes`.
- Storage quota is reserved before the upload URL is returned.
- If upload URL creation fails before transaction commit, the reservation and
  upload intent roll back.
- `sensitive: true` forces classification to `SENSITIVE`. Otherwise,
  `classification` defaults to `STANDARD`.
- For `COACHING_RELATIONSHIP` subjects, `subjectId` is required and is the
  coaching relationship id, not the trainee user id.
- For relationship-scoped document uploads, the actor must be relationship-self
  or assigned staff with the relevant workspace permissions.

### Upload Headers

The storage provider signs upload URLs with these headers:

- `content-length`
- `content-type`
- `if-none-match: *`
- `x-amz-checksum-sha256` when a checksum is supplied

Important implementation gap: the backend service currently returns
`uploadUrl`, expiry, reserved bytes, and expected version, but does not echo the
storage provider's signed `headers` object in the API response. The frontend
should send headers matching the upload intent values when uploading directly to
storage. This is repository behavior, not a new API contract. If direct browser
uploads fail because signed headers are unavailable, create a follow-up
implementation issue rather than changing V1 documentation.

## Direct Object Upload

After receiving the upload intent response, upload the file bytes directly to
`uploadUrl`.

Frontend upload requirements from implementation evidence:

- Use HTTP `PUT` to the returned storage URL.
- Send the same content type as `mimeType`.
- Send the same content length as `sizeBytes`.
- Do not overwrite an existing object; provider uses `if-none-match: *`.
- If `checksumSha256` was supplied to the backend, include the matching
  SHA-256 checksum header expected by the storage provider.
- Do not send the file bytes to the backend API.

The frontend should treat object upload failure as a pending/failed client-side
upload and may retry the storage PUT while the upload URL is still valid. If the
URL or intent expires, create a new upload intent.

## Confirm Upload

Request:

```http
POST /api/v1/workspaces/:workspaceId/files/upload-intents/:uploadIntentId/confirm
Idempotency-Key: <unique-command-key>
Content-Type: application/json

{ "expectedVersion": 0 }
```

Confirmation behavior:

- Loads the upload intent by workspace and id.
- Requires the intent to be `PENDING`.
- Requires `expectedVersion` to match the intent version.
- Rejects expired intents.
- Performs storage `HEAD` through the configured storage provider.
- Requires storage object key to match the reserved key.
- Requires object size to be non-negative and no larger than reserved bytes.
- Allows an actual object size smaller than reserved bytes.
- If storage provides `contentType`, it must match reserved MIME type
  case-insensitively.
- If an expected checksum was supplied, storage metadata must include
  `checksumSha256`.
- If both expected and storage checksums exist, they must match
  case-insensitively.
- Creates an `ACTIVE` file with version `0`.
- Marks the upload intent `CONFIRMED`.
- Moves usage from `reservedStorageBytes` to `storageBytes` using reserved bytes
  and actual bytes.

Successful response:

```json
{
  "data": {
    "file": {
      "id": "fileId",
      "status": "ACTIVE",
      "originalName": "plan.pdf",
      "mimeType": "application/pdf",
      "sizeBytes": 400,
      "classification": "STANDARD",
      "version": 0,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "confirmedAt": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

Confirmation validation failures do not create file records and do not release
reserved quota immediately. The reservation remains recoverable until the upload
intent expiry job releases it.

## SHA-256 Semantics

`checksumSha256` is optional. When supplied:

- It must normalize to exactly 64 hex characters.
- Invalid values fail with `CHECKSUM_INVALID`.
- The backend records it as `expectedChecksumSha256` on the upload intent.
- The upload URL is generated with a checksum header.
- Confirmation trusts only authoritative storage provider checksum metadata.
- ETag is not treated as SHA-256 verification.
- If storage metadata lacks `checksumSha256`, confirmation fails with
  `UPLOAD_CHECKSUM_NOT_VERIFIABLE`.
- If storage checksum does not match, confirmation fails with
  `UPLOAD_OBJECT_MISMATCH`.
- On success, the file stores `verifiedChecksumSha256`.

If no checksum was supplied, confirmation can succeed without storage checksum
metadata.

## Document Metadata

Create a document after confirming a file:

```http
POST /api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents
Idempotency-Key: <unique-command-key>
Content-Type: application/json

{
  "fileId": "fileId",
  "category": "OTHER",
  "title": "Plan",
  "description": "Optional",
  "classification": "STANDARD",
  "documentDate": "2026-01-01T00:00:00.000Z"
}
```

Implemented categories:

- `INBODY`
- `BLOOD_TEST`
- `MEDICAL_REPORT`
- `DIET_DOCUMENT`
- `TRAINING_DOCUMENT`
- `INJURY_REPORT`
- `OTHER`

Mandatory sensitive categories:

- `INBODY`
- `BLOOD_TEST`
- `MEDICAL_REPORT`
- `INJURY_REPORT`

Rules:

- The file must be `ACTIVE`.
- The file must be user-uploaded; system-generated files cannot be attached as
  relationship documents.
- The file `subjectId` must equal the relationship id.
- Each file can be attached to at most one active document; duplicate attempts
  fail with `DOCUMENT_FILE_ALREADY_USED`.
- If document category requires sensitivity, classification becomes
  `SENSITIVE` even if the request/file was standard.
- If the document is sensitive, upload requires `medical_documents.upload`.
- If a standard file is attached as a sensitive document, service mutates the
  in-memory file classification before document creation, but the repository
  call shown in the locked implementation does not persist that file
  classification change directly. Download sensitivity is still enforced through
  the linked document classification.
- `documentDate` is parsed as a JavaScript `Date`; invalid values fail with
  `DOCUMENT_DATE_INVALID`. Use timezone-qualified ISO strings.

Response body:

```json
{
  "data": {
    "document": {
      "id": "documentId",
      "relationshipId": "relationshipId",
      "fileId": "fileId",
      "category": "OTHER",
      "title": "Plan",
      "classification": "STANDARD",
      "status": "ACTIVE",
      "version": 0,
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

Document creation writes audit event `DocumentCreated` and outbox event
`DocumentUploaded`.

## List And Read Documents

List route:

```http
GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents?limit=50&cursor=...
```

Response shape is not wrapped in a top-level `data` object by the route; the
service returns:

```json
{
  "data": [
    {
      "id": "documentId",
      "relationshipId": "relationshipId",
      "fileId": "fileId",
      "category": "OTHER",
      "classification": "STANDARD",
      "status": "ACTIVE",
      "version": 0,
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "pageInfo": {
    "hasMore": true,
    "nextCursor": "opaque"
  }
}
```

Pagination:

- Ordering is `createdAt` descending, then `_id` descending.
- Cursor is an opaque `createdAt_id` token.
- `limit` defaults to 50 and schema allows 1 through 100.
- The implementation computes `pageInfo.hasMore` as `documents.length >= 50`,
  not against the requested limit. Use `pageInfo.nextCursor` as the primary
  continuation signal.
- Cursor failures return `CURSOR_INVALID`.

Sensitive documents:

- Listing iterates returned documents and requires sensitive read permission for
  each sensitive document before including it.
- Reading one sensitive document also requires sensitive read permission.
- Denials surface as permission errors, not as redacted fields.

Get route:

```http
GET /api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents/:documentId
```

Response is wrapped as `{ data: { document } }`.

## Download URL

Request:

```http
POST /api/v1/workspaces/:workspaceId/files/:fileId/download-url
```

Response:

```json
{
  "data": {
    "url": "https://...",
    "expiresAt": "2026-01-01T00:05:00.000Z"
  }
}
```

Download behavior:

- Only `ACTIVE` user-uploaded files are downloadable through this route.
- System-generated files are hidden from this file route and return
  `FILE_NOT_FOUND`.
- Non-active files fail with `FILE_NOT_AVAILABLE`.
- If the file is linked to an active document, relationship scope and document
  sensitivity are used for authorization.
- If the file is not linked to a document, authorization is based on file subject
  context.
- Standard download URLs last 5 minutes.
- Sensitive download URLs last 2 minutes.
- The storage provider creates an attachment URL with safe filename and response
  content type parameters.
- Sensitive download URL issuance writes audit event
  `SensitiveFileDownloadUrlIssued`.
- If sensitive download audit writing fails, the download URL request fails; the
  test verifies no audit event is recorded in that failure case.

Frontend guidance:

- Request a fresh download URL only when the user initiates download/preview.
- Do not cache signed URLs beyond their `expiresAt`.
- Do not log signed URLs. The logging layer redacts `uploadUrl`/`downloadUrl`,
  and frontend telemetry should do the same.
- If a download URL fails after expiry, request a new one rather than reusing
  the old URL.

## Delete, Restore, And Purge

Delete file:

```http
DELETE /api/v1/workspaces/:workspaceId/files/:fileId
Idempotency-Key: <unique-command-key>
Content-Type: application/json

{ "expectedVersion": 0 }
```

File deletion behavior:

- Requires an active user-uploaded file.
- Requires `files.delete`.
- Requires `expectedVersion`.
- Sets status to `SOFT_DELETED`.
- Sets `deletedAt`, `deletedBy`, and `purgeEligibleAt`.
- Restore window is 30 days.
- Writes audit event `FileSoftDeleted`.

Restore file:

```http
POST /api/v1/workspaces/:workspaceId/files/:fileId/restore
Idempotency-Key: <unique-command-key>
Content-Type: application/json

{ "expectedVersion": 1 }
```

Restore behavior:

- Requires `files.restore`.
- Requires status `SOFT_DELETED`.
- Requires `purgeEligibleAt` to be strictly greater than current time.
- At the exact purge eligibility cutoff, restore fails with
  `FILE_RESTORE_INVALID`.
- Restores status to `ACTIVE`.
- Unsets delete/purge eligibility fields.
- Writes audit event `FileRestored`.

Purge behavior:

- Background file job claims due files with status `SOFT_DELETED` or
  `PURGE_PENDING` where `purgeEligibleAt <= now`.
- It marks them `PURGE_PENDING`, deletes the object from storage, then marks
  them `PURGED`.
- For user-uploaded files, committed storage is released only after database
  purge finalization.
- Provider delete failures keep the file retryable and do not release committed
  storage.
- If storage delete succeeds but DB finalization fails, the file remains
  `PURGE_PENDING`; retrying finalizes purge and releases quota.

## Delete Document

Request:

```http
DELETE /api/v1/workspaces/:workspaceId/relationships/:relationshipId/documents/:documentId
Idempotency-Key: <unique-command-key>
Content-Type: application/json

{ "expectedVersion": 0 }
```

Document delete behavior:

- Requires `documents.delete`.
- Requires open relationship lifecycle for write.
- Requires `expectedVersion`.
- Sensitive documents require `medical_documents.upload` in the locked
  implementation because delete uses the same sensitive write gate as upload.
- Sets document status to `DELETED`.
- If the linked file is still `ACTIVE`, soft-deletes that file in the same
  transaction using the file's current version.
- Writes audit event `DocumentDeleted`.

There is no public document restore route in V1.

## Status Reference

Upload intent statuses:

| Status | Meaning | Frontend behavior |
| --- | --- | --- |
| `PENDING` | Reservation exists and can be confirmed before expiry. | Show upload in progress/pending. |
| `CONFIRMED` | Backend created file metadata. | Move to file/document step. |
| `EXPIRED` | Expiry job released reserved storage. | Restart upload with a new intent. |
| `CANCELLED` | Type exists, but no public cancel route is implemented in V1. | Do not expose cancel unless future API adds it. |

File statuses:

| Status | Meaning | Frontend behavior |
| --- | --- | --- |
| `ACTIVE` | File is available for download/metadata use. | Normal display. |
| `SOFT_DELETED` | File is deleted but restorable before purge cutoff. | Hide from active lists; admin restore can use latest file version if surfaced. |
| `PURGE_PENDING` | Purge worker is deleting/finalizing. | Treat as unavailable. |
| `PURGED` | Physical delete finalized. | Treat as gone. |

Document statuses:

| Status | Meaning | Frontend behavior |
| --- | --- | --- |
| `ACTIVE` | Relationship document is visible when permissions allow. | Normal display. |
| `DELETED` | Document metadata deleted. | Hide from active document lists. |

Generated file intent statuses are backend-internal for system-generated files:
`PENDING`, `OBJECT_WRITTEN`, `FILE_CREATED`, `CLEANED`, `FAILED`.

## Permissions And Sensitive Access

Primary workspace permissions:

- `documents.read`
- `documents.upload`
- `documents.delete`
- `files.download`
- `files.delete`
- `files.restore`
- `medical_documents.read`
- `medical_documents.upload`
- `medical_documents.download`

Support-sensitive permissions:

- `support.sensitive.read`
- `support.sensitive_files.read`

Sensitive behavior:

- Sensitive document categories force sensitive classification.
- Sensitive document read/list requires `medical_documents.read`.
- Sensitive document upload requires `medical_documents.upload`.
- Sensitive file download requires `medical_documents.download`.
- Support context also requires a support session with `allowSensitiveData`.
- Sensitive file download in support context additionally requires platform
  `support.sensitive_files.read` and session `allowSensitiveFileDownload`.
- Support denial codes include `SUPPORT_SENSITIVE_DENIED` and
  `SUPPORT_SENSITIVE_FILE_DENIED`.

Relationship scope:

- Relationship document APIs authorize by `relationshipId`.
- A trainee can access their own relationship where service self logic allows.
- Staff must be assigned to the relationship or otherwise pass workspace access
  plus assignment checks.
- Assignment revocation blocks new linked-file download URLs.

## Quota And Entitlement

Upload intent creation calls subscription entitlement check for `UPLOAD` and
then reserves storage.

Quota behavior:

- New upload intent can fail with `SUBSCRIPTION_FROZEN` when workspace access is
  read-only/frozen.
- New upload intent can fail with `FEATURE_NOT_AVAILABLE` if upload is not
  available under terms.
- Missing terms or full quota can fail with `STORAGE_LIMIT_EXCEEDED`.
- Storage reservation uses `storageBytes + reservedStorageBytes + requestedBytes
  <= limit` in one atomic update.
- Confirmation after a workspace is frozen is still allowed for an existing
  reservation; tests verify this.
- Confirmation commits actual bytes and releases reserved bytes.
- Upload expiry releases reserved bytes.
- File purge releases committed storage bytes for user-uploaded files.
- Accounting conflicts surface as `STORAGE_ACCOUNTING_CONFLICT`.

Frontend guidance:

- Check file size and MIME type before asking for an upload intent.
- Treat quota/subscription errors as blocking; retry only after smaller file,
  cleanup, or subscription change.
- Show reserved/pending upload state separately from committed storage where
  product UI exposes usage.

## Background Jobs

`FileJobRunner.runDueJobs()` runs three leased jobs:

- `expire-upload-intents`
- `purge-files`
- `cleanup-generated-file-intents`

Upload expiry:

- Finds `PENDING` intents with `expiresAt <= now`.
- Marks them `EXPIRED`.
- Releases reserved storage.
- Writes audit event `UploadIntentExpired`.
- Cleans orphaned uploaded objects for expired/cancelled intents.

Purge:

- Processes files due for purge.
- Deletes storage objects.
- Marks files `PURGED`.
- Releases committed storage for user uploads.
- Writes audit event `FilePurged`.

Generated file intent cleanup:

- Cleans export/generated objects when a generated file was not finalized.
- This is backend/internal; frontend should use export APIs for generated
  export downloads.

## Error Catalog

| Code | HTTP | When it occurs | Frontend behavior |
| --- | --- | --- | --- |
| `FILE_TOO_LARGE` | 422 | Upload intent exceeds 200 MiB or non-positive size. | Block before upload and show size limit. |
| `UNSUPPORTED_FILE_TYPE` | 422 | MIME type is not in the allowed set. | Restrict picker and show accepted types. |
| `FILE_NAME_REQUIRED` | 422 | Trimmed file name is empty. | Require file name. |
| `SUBJECT_REQUIRED` | 422 | Relationship upload missing `subjectId`. | Send relationship id. |
| `CHECKSUM_INVALID` | 422 | Checksum is not 64 hex chars. | Recompute/correct checksum or omit it. |
| `UPLOAD_OBJECT_NOT_FOUND` | 404 | Confirm before object exists in storage. | Retry confirm after upload, or restart upload. |
| `UPLOAD_OBJECT_MISMATCH` | 409 | Object key/size/content-type/checksum does not match reservation. | Mark upload failed and start a new intent/upload. |
| `UPLOAD_CHECKSUM_NOT_VERIFIABLE` | 409 | Expected checksum exists but storage HEAD has no checksum metadata. | Start a new upload path that supplies provider checksum metadata. |
| `UPLOAD_INTENT_NOT_FOUND` | 404 | Intent id invalid/missing. | Restart upload. |
| `UPLOAD_INTENT_NOT_PENDING` | 409 | Intent already confirmed/expired/cancelled. | Refresh/restart upload. |
| `UPLOAD_INTENT_VERSION_CONFLICT` | 409 | Stale confirm `expectedVersion`. | Refetch/restart upload; do not blindly retry stale body. |
| `UPLOAD_INTENT_EXPIRED` | 409 | Confirming after intent expiry. | Create new upload intent. |
| `UPLOAD_ALREADY_CONFIRMED` | 409 | Unique file for intent already exists. | Refresh file state. |
| `FILE_NOT_FOUND` | 404 | File absent, invalid, system-generated in user file route, or hidden. | Refresh parent state. |
| `FILE_NOT_AVAILABLE` | 409 | File is not active for download/delete. | Refresh file/document state. |
| `FILE_VERSION_CONFLICT` | 409 | Stale delete `expectedVersion`. | Refetch file version. |
| `FILE_RESTORE_INVALID` | 409 | Restore is not allowed due to status/version/cutoff. | Refresh file state; do not retry after cutoff. |
| `DOCUMENT_NOT_FOUND` | 404 | Document absent, deleted, invalid, or hidden. | Refresh document list. |
| `DOCUMENT_FILE_ALREADY_USED` | 409 | File already has a document. | Refresh documents or choose a different file. |
| `DOCUMENT_VERSION_CONFLICT` | 409 | Stale document delete version. | Refetch document. |
| `DOCUMENT_DATE_INVALID` | 422 | `documentDate` cannot be parsed. | Send timezone-qualified ISO date/time. |
| `FORBIDDEN` / `PERMISSION_DENIED` | 403 | Actor/scope/sensitive gate denies access. | Hide action or request permission. |
| `STORAGE_LIMIT_EXCEEDED` | 403 | Storage quota unavailable/exceeded. | Block upload until quota changes. |
| `STORAGE_ACCOUNTING_CONFLICT` | 409 | Reservation/commit/release counters no longer match. | Refetch usage and report if repeated. |
| `SUBSCRIPTION_FROZEN` | 403 | New write/upload blocked by subscription state. | Show frozen workspace state. |
| `SUPPORT_SENSITIVE_DENIED` | 403 | Support session lacks sensitive data allowance. | Hide sensitive content in support mode. |
| `SUPPORT_SENSITIVE_FILE_DENIED` | 403 | Support session lacks sensitive file download allowance. | Hide sensitive download in support mode. |

## Frontend Sequences

### Standard Relationship Document Upload

1. User selects a supported file.
2. Frontend computes optional SHA-256 if product wants checksum verification.
3. `POST /files/upload-intents` with `purpose=DOCUMENT`,
   `subjectType=COACHING_RELATIONSHIP`, and `subjectId=<relationshipId>`.
4. Upload bytes to `uploadUrl`.
5. `POST /upload-intents/:id/confirm` with returned `expectedVersion`.
6. `POST /relationships/:relationshipId/documents` with confirmed `fileId`.
7. Refresh document list.

### Sensitive Medical Document Upload

1. Use a category such as `MEDICAL_REPORT`, `BLOOD_TEST`, `INBODY`, or
   `INJURY_REPORT`, or explicitly set classification `SENSITIVE`.
2. Ensure the actor has `documents.upload` plus the relevant
   `medical_documents.upload` gate.
3. Run the same upload/confirm/create sequence.
4. Expect sensitive read/download gates later.

### Download

1. User clicks download.
2. `POST /files/:fileId/download-url`.
3. If successful, navigate/download using returned URL immediately.
4. If URL expires or fails due expiry, request a new URL.
5. If denied, refresh permissions/document state and show restricted access.

### Delete Document

1. Read the document to get current `version`.
2. `DELETE /relationships/:relationshipId/documents/:documentId` with
   `expectedVersion`.
3. Backend deletes document metadata and soft-deletes linked active file.
4. Refresh document list.

### Restore File

V1 exposes file restore but not an active document restore route. If a frontend
admin/recovery UI exposes file restore, it must:

1. Read or otherwise obtain the soft-deleted file id and current file version.
2. Call `POST /files/:fileId/restore` before `purgeEligibleAt`.
3. Refetch file/document state.

No current document list route returns deleted files/documents, so a full restore
UX may require a future read surface rather than guessing from active lists.

## Non-Public/Internal Details

Frontend must not depend on:

- storage keys;
- bucket names;
- Mongo collection names;
- internal `GeneratedFileIntent` state;
- worker lease keys;
- internal object cleanup retries;
- exact storage provider signing implementation;
- cursor encoding beyond treating it as opaque.

## Known Follow-Up

UNVERIFIED -- REQUIRES FOLLOW-UP: the API route response for upload intent does
not expose provider-signed upload headers, while `S3CompatibleStorageProvider`
does sign `content-length`, `content-type`, `if-none-match`, and optional
`x-amz-checksum-sha256`. Browser/client upload integration should be verified
against the deployed storage provider before frontend release. If clients cannot
complete direct upload reliably, create a future implementation issue to expose
required upload headers or adjust signing behavior.
