# CloudVault HTTP API

The AWS integration expects API Gateway HTTP API payload 2.0. JSON fields use camelCase, dates are UTC ISO 8601, and file, folder, and operation IDs are canonical UUIDs. The frontend has independent AWS and IndexedDB demo modes. The loopback Python simulator retains the original Phase 1 behavior.

## Authentication and transport

Attach the Cognito JWT authorizer and `cloudvault/workspace` access-token scope to every protected data route. `GET /health` and browser preflight `OPTIONS` are unauthenticated. The Lambda checks the verified issuer, app client, access-token use, scope, expiry and configured owner `sub`. File and folder operations resolve through that owner's DynamoDB partition. Pass `Authorization: Bearer <access_token>` over HTTPS. API Gateway validates signatures, so function invocation is restricted to that trusted gateway. Configure exact origins in API Gateway, Lambda and S3. OPTIONS carries no workspace data.

The Python loopback simulator uses a separate random local bearer token of at least 32 characters. The browser's demo mode uses IndexedDB directly and needs no Python server.

## Schemas

- `FileRecord` is `{id, name, contentType, size, folderId, status, createdAt, updatedAt}`. `folderId` is UUID or null. `status` is `pending`, `active` or `deleted`. AWS adds `processingState` and nullable `currentVersionId`. Processing states are `awaitingUpload`, `uploadInProgress`, `deleteInProgress`, `restoreInProgress`, `ready`, `rejected` and `stale`.
- `Version` is `{versionId, size, createdAt, isLatest, isDeleteMarker}`. The version ID is an opaque string. Delete markers have size zero.
- `Activity` is `{id, action, fileId, fileName, createdAt}`. Cloud activity records state changes and link creation. It cannot observe whether a recipient downloaded a presigned link.
- `Folder` is `{id, name}`. Folders are flat, and names are unique ignoring case. Rename and move of files modify metadata only.
- `Share` is `{id, fileId, fileName, versionId, url, createdAt, expiresAt}`. The URL is empty in cloud inventory after expiration.
- Collection responses are `{items: T[], nextCursor: string|null}`. `limit` defaults to 25 and accepts 1–100. Cursors are opaque and scoped to their owner and query. File sorting and search operate on a bounded owner query and use an offset cursor, so changes between pages can shift results. Activity, folder and share cursors resume DynamoDB queries. Version cursors carry both S3 markers and remain restricted to the exact file key.
- Errors from the handler have `{error: {code, message, requestId}}`. Gateway-generated errors can have a different shape.

The upload size range is 1–5,242,880 bytes. Cloud mode requires matching type and extension pairs `text/plain/.txt`, `text/csv/.csv`, `application/json/.json`, `application/pdf/.pdf`, `image/png/.png`, and `image/jpeg/.jpg or .jpeg`. Names are 1–180 characters without slash, backslash or control characters. Cloud rename preserves a matching extension. Verification checks exact byte length, declared MIME, version and SSE-S3 metadata. The system does not inspect file contents for malware or validate full file-format syntax.

## Routes

| Method and path | Request | AWS success |
| --- | --- | --- |
| POST `/files/upload-url` | `{name,contentType,size,folderId?:UUID|null}` | 201 `{file,uploadUrl,expiresIn,requiredHeaders,mode:"aws"}`. URL is a presigned PUT and expiry is at most 300 seconds. A replay for an already active file returns a null URL. |
| POST `/files/confirm-upload` | `{fileId}` | 200 `{file,mode:"aws"}`. Verifies staged data and promotes it, or returns the previously confirmed file. |
| GET `/files` | Optional `status=active\|pending\|deleted\|all`, `q`, `folderId=UUID\|root`, `sort=name\|size\|updatedAt`, `order=asc\|desc`, `limit`, `cursor` | 200 FileRecord collection. Defaults to active, updatedAt descending. Omitting folderId includes all folders. |
| GET `/files/{id}/download` | Optional `versionId` query parameter | 200 `{url,expiresIn:300,versionId}`. With no parameter, checks the current S3 version against the active record. With a parameter, verifies and signs that exact content version of the active file. |
| PATCH `/files/{id}` | One or both of `{name,folderId}` | 200 `{file}`. |
| DELETE `/files/{id}` | No body | 204. Soft delete writes a marker if content is present. Repeating delete on a deleted file succeeds. |
| GET `/files/{id}/versions` | Optional `limit,cursor` | 200 Version collection. Includes delete markers and files in trash. |
| POST `/files/{id}/restore` | `{versionId}` | 200 `{file,mode:"aws"}`. Restores by copying an exact content version to the canonical key. |
| POST `/files/{id}/share` | `{expiresIn}` in integer seconds, 60–900 | 201 Share. Checks current active S3 content and pins the version. |
| GET `/shares` | Optional `limit,cursor` | 200 Share collection. Re-signs unexpired links for only the remaining original lifetime. |
| GET `/folders` | Optional `limit,cursor` | 200 Folder collection. |
| POST `/folders` | `{name}` (1–80 characters) | 201 `{folder}`. |
| GET `/activity` | Optional `limit,cursor` | 200 Activity collection, reverse chronological. |
| GET `/analytics` | No body | 200 `{fileCount,totalSize,deletedCount,types:[{contentType,count,size}],retainedVersionCount,retainedBytes,recentActivity,scope,mode:"aws"}`. Totals describe workspace metadata. |
| GET `/health` | No body | 200 `{status:"ok",mode:"aws",awsConnected:null}`. Lightweight liveness without calling AWS services. |

Common status codes are 400 for invalid input or selecting a delete marker, 401 for invalid access tokens, 403 for a wrong owner or denied origin, 404 for missing files/folders/routes, 409 for stale state, missing objects, operation leases or a workspace limit, and 503 for missing configuration or upstream errors. API Gateway can return 429 when throttled. The loopback simulator preserves its null upload URL, simulated confirmation, 501 download/share responses, root-only folder handling and existing routes. `status=all`, `/folders` and `/shares` are AWS extensions.

## Upload and operation retries

Send an optional UUID `Idempotency-Key` header on upload intent creation, delete, and restore. The cloud client reuses a key after a failed API response for the same action in that session. Upload retries use the same staged key and original expiry, so they consume one intent slot. Delete/restore receipts last at least seven days subject to TTL cleanup. A completed replay returns current metadata for a restore and 204 for a delete.

The frontend PUT sends the API-provided headers and lets the browser supply the signed Content-Length from the File body. The API never accepts arbitrary object keys. A staging version can be confirmed after the PUT response is lost. After an interrupted promotion, select the pending row and confirm again. For an interrupted delete or restore, repeat the same action and source version after the 60-second writer lease. A different operation on that file waits until the pending operation is reconciled.

S3 and DynamoDB do not provide a cross-service transaction. CloudVault holds a conditional lease in DynamoDB, detects an already-applied marker or a copy tagged with the operation ID, and commits file metadata and activity together. Keep all writes to the canonical prefix inside CloudVault. Manual changes or a permanently lost S3 version can require operator inspection. [Architecture and consistency details](architecture.md).

## Presigned sharing

A presigned GET is a bearer capability tied to one version. Anyone who obtains it can use it until its expiry or the signer credentials expire, whichever comes first. Soft delete leaves version-pinned links valid while the underlying version remains. CloudVault stores share metadata and signs URLs on demand. The browser demo has separate links scoped to the originating browser database. [AWS presigned URL behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).
