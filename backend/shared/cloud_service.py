"""Single-owner workspace and coordination of non-atomic S3/DynamoDB writes."""
import base64
from hashlib import sha256
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import PurePosixPath
from uuid import UUID, uuid5

from backend.shared.aws_adapters import WriteConflict, versioned
from backend.shared.interfaces import MetadataRepository, NotificationPublisher, ObjectStore
from backend.shared.models import MAX_FILE_SIZE, ApiError, FileRecord
from backend.shared.service import now, object_key, uid
from backend.shared.validation import exact_fields, identifier, invalid, name, upload

log = logging.getLogger(__name__)
MAX_FILES = 200
MAX_FOLDERS = 40
UPLOAD_SECONDS = 300
LEASE_SECONDS = 60  # Must exceed the maximum timeout of any writer Lambda.
DAY = 86400
EXTENSIONS = {
    "application/pdf": {".pdf"}, "text/plain": {".txt"}, "text/csv": {".csv"},
    "application/json": {".json"}, "image/png": {".png"}, "image/jpeg": {".jpg", ".jpeg"},
}


def timestamp(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def public_file(row):
    return {**{field: row[field] for field in FileRecord.__dataclass_fields__},
            "processingState": row.get("processingState", "ready"),
            "currentVersionId": row.get("versionId") if row["status"] == "active" else None}


def conflict(message="Another operation changed this file. Refresh and retry."):
    return ApiError(409, "STATE_CONFLICT", message)


def parse_page(query, scope):
    try:
        limit = int(query.get("limit", "25"))
        if not 1 <= limit <= 100:
            invalid("limit must be 1–100.")
        raw = query.get("cursor")
        if raw is None:
            return limit, None
        if len(raw) > 8192:
            invalid("Invalid cursor.")
        actual_scope, position = json.loads(base64.urlsafe_b64decode(raw))
        if actual_scope != scope:
            invalid("Cursor does not match this query.")
        return limit, position
    except (ValueError, TypeError):
        invalid("Invalid pagination parameters.")


def page(items, scope, position):
    return {"items": items, "nextCursor": None if position is None else
            base64.urlsafe_b64encode(json.dumps([scope, position], separators=(",", ":")).encode()).decode()}


class CloudService:
    def __init__(self, repo: MetadataRepository, storage: ObjectStore, owner: str,
                 publisher: NotificationPublisher | None = None, notifications=False):
        self.repo, self.storage, self.owner = repo, storage, owner
        self.publisher, self.notifications = publisher, notifications

    def key(self, file_id):
        return object_key(self.owner, file_id)

    def staging(self, file_id):
        return f"uploads/{self.owner}/{file_id}/content"

    def get(self, file_id, active=False):
        row = self.repo.get_file(self.owner, identifier(file_id))
        if not row:
            raise ApiError(404, "NOT_FOUND", "File not found.")
        if active and (row["status"] != "active" or row.get("operation")):
            raise conflict("The file is not active or an operation is in progress.")
        return row

    def activity(self, action, row, stamp=None):
        stamp, event_id = stamp or now(), uid()
        return self.repo.put(self.owner, f"ACTIVITY#{stamp}#{event_id}", {
            "id": event_id, "fileId": row["id"], "fileName": row["name"],
            "action": action, "createdAt": stamp, "expiresAtEpoch": int(time.time()) + 30 * DAY,
        })

    def create(self, changes, limit_message):
        try:
            self.repo.transact(changes, uid())
        except WriteConflict:
            raise conflict(limit_message) from None

    def check_folder(self, folder_id):
        if folder_id is not None and not self.repo.get(self.owner, f"FOLDER#{identifier(folder_id)}"):
            raise ApiError(404, "FOLDER_NOT_FOUND", "Folder not found.")

    def request_upload(self, data, request_key=None):
        upload(data)
        filename = name(data["name"])
        if PurePosixPath(filename).suffix.lower() not in EXTENSIONS[data["contentType"]]:
            invalid("The filename extension must match the declared file type.")
        folder = data.get("folderId")
        self.check_folder(folder)
        file_id = str(uuid5(UUID(self.owner), "upload:" + identifier(request_key))) if request_key is not None else uid()
        digest = sha256(json.dumps([filename, folder, data["contentType"], data["size"]]).encode()).hexdigest()
        row = self.repo.get_file(self.owner, file_id) if request_key is not None else None
        if not row:
            stamp = now()
            row = FileRecord(file_id, filename, data["contentType"], data["size"], folder, "pending", stamp, stamp).json()
            row.update(revision=0, processingState="awaitingUpload", uploadRequest=digest,
                       uploadExpiresAt=int(time.time()) + UPLOAD_SECONDS)
            try:
                self.repo.transact([self.repo.put(self.owner, f"FILE#{file_id}", row),
                                    self.repo.increment(self.owner, "QUOTA#FILES", MAX_FILES)], uid())
            except WriteConflict:
                row = self.repo.get_file(self.owner, file_id)
                if not row:
                    raise conflict("The workspace file intent limit was reached or a write conflicted. Refresh and retry.") from None
        if row.get("uploadRequest") != digest:
            raise conflict("The retry key was already used for a different upload.")
        remaining = row["uploadExpiresAt"] - int(time.time())
        if row["status"] == "deleted" or (row["status"] == "pending" and remaining <= 0):
            raise ApiError(409, "UPLOAD_INTENT_EXPIRED", "The upload intent expired. Start a new upload.")
        url = (self.storage.presign_put(self.staging(file_id), row["contentType"], row["size"], remaining)
               if row["status"] == "pending" else None)
        return {"file": public_file(row), "uploadUrl": url, "expiresIn": remaining if url else 0,
                "requiredHeaders": {"Content-Type": row["contentType"], **self.storage.upload_headers} if url else {},
                "mode": "aws"}

    def current(self, key):
        result = self.storage.list_versions(key, limit=1)
        return next((row for row in result["items"] if row["isLatest"]), None)

    def verify(self, key, version_id, expected=None):
        if not versioned(version_id):
            raise ApiError(409, "VERSIONING_REQUIRED", "The object has no usable S3 version.")
        head = self.storage.head(key, version_id)
        if head and head.get("DeleteMarker"):
            invalid("Select a retained content version, not a delete marker.")
        if head is None:
            raise ApiError(409, "OBJECT_MISSING", "The requested object version is missing.")
        if (head.get("VersionId") != version_id or head.get("ServerSideEncryption") != "AES256"
                or not 1 <= head.get("ContentLength", 0) <= MAX_FILE_SIZE
                or head.get("ContentType") not in EXTENSIONS):
            raise ApiError(409, "OBJECT_INVALID", "The object failed version, encryption, size, or type verification.")
        if expected and (head["ContentLength"] != expected["size"] or head["ContentType"] != expected["contentType"]):
            raise ApiError(409, "OBJECT_INVALID", "The uploaded object does not match the upload request.")
        return head

    def confirmed_upload(self, file_id, event_version=None, sequencer=None):
        row = self.get(file_id)
        if row["status"] != "pending":
            # A later event can never replace accepted, deleted, or restored content.
            if row["status"] == "deleted" and event_version is None:
                raise conflict("Deleted files cannot be confirmed.")
            return row
        op = row.get("operation")
        staging_key = self.staging(file_id)
        if op:
            if event_version is not None and op["source"] != event_version:
                return row
            source = op["source"]
        else:
            current = self.current(staging_key)
            if not current or current["isDeleteMarker"]:
                raise ApiError(409, "UPLOAD_NOT_FOUND", "S3 has not received this upload.")
            source = current["versionId"]
            if event_version is not None and source != event_version:
                return row
            try:
                self.verify(staging_key, source, row)
            except ApiError as error:
                if error.code == "OBJECT_INVALID":
                    self.update(row, {"processingState": "rejected"})
                raise
        row = self.acquire(row, "upload", source, None, sequencer=sequencer)
        return self.apply_operation(row)

    def confirm(self, data):
        exact_fields(data, {"fileId"}, {"fileId"})
        return {"file": public_file(self.confirmed_upload(data["fileId"])), "mode": "aws"}

    def update(self, row, fields, action=None, extra=()):
        updated = {**row, **fields, "revision": row["revision"] + 1}
        changes = [self.repo.put(self.owner, f"FILE#{row['id']}", updated, row["revision"]), *extra]
        if action:
            changes.append(self.activity(action, updated, updated["updatedAt"]))
        self.create(changes, "Another request changed this file. Refresh and retry.")
        return updated

    def acquire(self, row, kind, source, request_key, *, sequencer=None):
        stamp = int(time.time())
        operation = row.get("operation")
        if operation:
            if operation["kind"] != kind or operation.get("source") != source:
                raise conflict("Retry the pending file operation before starting another.")
            if operation["leaseUntil"] > stamp:
                raise ApiError(409, "OPERATION_IN_PROGRESS", "A file operation is in progress. Try again shortly.")
        else:
            operation = {"id": uid(), "kind": kind, "source": source, "requestKey": request_key,
                         "sequencer": sequencer}
        operation = {**operation, "leaseUntil": stamp + LEASE_SECONDS}
        return self.update(row, {"operation": operation, "processingState": kind + "InProgress"})

    def receipt(self, file_id, request_key, kind, source):
        if request_key is None:
            return None
        row = self.repo.get(self.owner, f"OP#{file_id}#{identifier(request_key)}")
        if row and (row["kind"], row.get("source")) != (kind, source):
            raise conflict("The retry key was already used for a different operation.")
        return row

    def apply_operation(self, row):
        file_id, op = row["id"], row["operation"]
        key = self.key(file_id)
        current = self.current(key)
        current_version = current["versionId"] if current else None
        has_marker = bool(current and current["isDeleteMarker"])
        kind = op["kind"]
        retained_count = row.get("retainedVersionCount", 0)
        retained_bytes = row.get("retainedBytes", 0)
        if kind == "delete":
            if current and not has_marker and current_version != row.get("versionId"):
                self.update(row, {"operation": None, "processingState": "stale"})
                raise conflict("S3 has changed outside CloudVault. Inspect version history before retrying.")
            # A retry observes a marker produced by the previous invocation.
            marker = self.storage.create_delete_marker(key) if current and not has_marker else current_version
            fields = {"status": "deleted", "versionId": marker,
                      "retainedVersionCount": retained_count + int(current is not None),
                      "retainedBytes": retained_bytes + (row["size"] if current else 0)}
            action = "Moved to trash"
        else:
            head = self.storage.head(key, current_version) if current and not has_marker else None
            if head and head.get("Metadata", {}).get("cloudvault-operation") == op["id"]:
                # Copy succeeded before a previous invocation could commit DynamoDB.
                head = self.verify(key, current_version)
                new_version = current_version
            else:
                source_key = self.staging(file_id) if kind == "upload" else key
                if kind == "upload" and current:
                    self.update(row, {"operation": None, "processingState": "stale"})
                    raise conflict("Unexpected content exists at this file's storage key.")
                try:
                    head = self.verify(source_key, op["source"], row if kind == "upload" else None)
                except ApiError:
                    self.update(row, {"operation": None, "processingState": "rejected" if kind == "upload" else "stale"})
                    raise
                try:
                    new_version = self.storage.copy_version(
                        key, op["source"], op["id"], source_key=source_key, content_type=head["ContentType"]
                    )["VersionId"]
                except ApiError as error:
                    if error.code == "OBJECT_MISSING":
                        self.update(row, {"operation": None, "processingState": "stale"})
                    raise
            was_active = row["status"] == "active"
            fields = {"status": "active", "versionId": new_version,
                      "size": head["ContentLength"], "contentType": head["ContentType"],
                      "retainedVersionCount": retained_count + int(was_active),
                      "retainedBytes": retained_bytes + (row["size"] if was_active else 0)}
            if kind == "upload":
                fields.update(uploadVersionId=op["source"], uploadSequencer=op.get("sequencer"))
            else:
                fields["restoredFromVersionId"] = op["source"]
            action = "Uploaded" if kind == "upload" else "Version restored"
        extra = []
        if op.get("requestKey"):
            extra.append(self.repo.put(self.owner, f"OP#{file_id}#{op['requestKey']}", {
                "kind": kind, "source": op.get("source"), "expiresAtEpoch": int(time.time()) + 7 * DAY,
            }))
        return self.update(row, {**fields, "operation": None, "processingState": "ready",
                                 "updatedAt": now()}, action, extra)

    def patch(self, file_id, data):
        exact_fields(data, {"name", "folderId"})
        if not data:
            invalid("Provide name or folderId.")
        row = self.get(file_id, active=True)
        folder = data.get("folderId", row["folderId"])
        self.check_folder(folder)
        filename = name(data["name"]) if "name" in data else row["name"]
        if "name" in data and PurePosixPath(filename).suffix.lower() not in EXTENSIONS[row["contentType"]]:
            invalid("Keep an extension that matches the file type.")
        updated = self.update(row, {"name": filename, "folderId": folder, "updatedAt": now()},
                              "Renamed" if "name" in data else "Moved")
        return {"file": public_file(updated)}

    def delete(self, file_id, request_key=None):
        row = self.get(file_id)
        if self.receipt(file_id, request_key, "delete", None) or row["status"] == "deleted" and not row.get("operation"):
            return
        if row["status"] != "active":
            raise conflict("Only active files can be moved to trash.")
        self.apply_operation(self.acquire(row, "delete", None, request_key))

    def restore(self, file_id, data, request_key=None):
        exact_fields(data, {"versionId"}, {"versionId"})
        source = data["versionId"]
        if not isinstance(source, str) or not 1 <= len(source) <= 1024 or source == "null":
            invalid("Select an opaque content version ID.")
        row = self.get(file_id)
        if row["status"] == "pending":
            raise conflict("A pending file has no recoverable content.")
        receipt = self.receipt(file_id, request_key, "restore", source)
        if not receipt:
            same_content = (
                not row.get("operation") and row["status"] == "active"
                and source in {row.get("restoredFromVersionId"), row.get("versionId")}
            )
            if same_content:
                current = self.current(self.key(file_id))
                same_content = current and not current["isDeleteMarker"] and current["versionId"] == row["versionId"]
            if not same_content:
                row = self.apply_operation(self.acquire(row, "restore", source, request_key))
        if row.get("restoredFromVersionId") == source and self.notifications:
            self.notify_once(f"restore#{file_id}#{sha256(row['versionId'].encode()).hexdigest()}", "CloudVault recovery", "A retained file version was restored.")
        return {"file": public_file(row), "mode": "aws"}

    def verified_current(self, row):
        key = self.key(row["id"])
        current = self.current(key)
        if not current or current["isDeleteMarker"] or current["versionId"] != row["versionId"]:
            raise conflict("The current S3 object differs from file metadata. Inspect version history.")
        self.verify(key, row["versionId"], row)
        return key

    def download(self, file_id, version_id=None):
        row = self.get(file_id, active=True)
        if version_id is None:
            key, version_id = self.verified_current(row), row["versionId"]
        else:
            if not isinstance(version_id, str) or not 1 <= len(version_id) <= 1024:
                invalid("Select an opaque content version ID.")
            key = self.key(file_id)
            self.verify(key, version_id)
        return {"url": self.storage.presign_get(key, version_id, 300, row["name"]),
                "expiresIn": 300, "versionId": version_id}

    def versions(self, file_id, query):
        self.get(file_id)
        scope = f"{self.owner}:versions:{file_id}"
        limit, cursor = parse_page(query, scope)
        key = self.key(file_id)
        if cursor is not None and (not isinstance(cursor, list) or len(cursor) != 2 or cursor[0] != key
                                   or not isinstance(cursor[1], str) or len(cursor[1]) > 1024):
            invalid("Invalid version cursor.")
        result = self.storage.list_versions(key, cursor, limit)
        return page(result["items"], scope, result["nextCursor"])

    def files(self):
        return list(self.repo.all(self.owner, "FILE#", MAX_FILES))

    def list_files(self, query):
        status, sort, order = query.get("status", "active"), query.get("sort", "updatedAt"), query.get("order", "desc")
        if status not in {"active", "pending", "deleted", "all"} or sort not in {"name", "size", "updatedAt"} or order not in {"asc", "desc"}:
            invalid("Unknown status, sort or order.")
        folder, search = query.get("folderId"), query.get("q", "").casefold()
        if folder not in (None, "root"):
            identifier(folder)
        if len(search) > 180:
            invalid("Search is limited to 180 characters.")
        scope = [self.owner, status, sort, order, folder, search]
        limit, cursor = parse_page(query, scope)
        if cursor is not None and (type(cursor) is not int or not 0 <= cursor <= MAX_FILES):
            invalid("Invalid file cursor.")
        rows = [row for row in self.files() if (status == "all" or row["status"] == status) and search in row["name"].casefold()
                and (folder is None or row["folderId"] == (None if folder == "root" else folder))]
        rows.sort(key=lambda row: (row[sort].casefold() if sort == "name" else row[sort], row["id"]),
                  reverse=order == "desc")
        start = cursor or 0
        end = start + limit
        return page([public_file(row) for row in rows[start:end]], scope, end if end < len(rows) else None)

    def collection(self, prefix, query, fields):
        scope = f"{self.owner}:{prefix}"
        limit, cursor = parse_page(query, scope)
        if cursor is not None and (not isinstance(cursor, str) or not cursor.startswith(prefix) or len(cursor) > 150):
            invalid("Invalid collection cursor.")
        rows, last = self.repo.query(self.owner, prefix, limit=limit, start=cursor, descending=True)
        return page([{field: row[field] for field in fields} for row in rows], scope, last)

    def list_activity(self, query):
        return self.collection("ACTIVITY#", query, ("id", "fileId", "fileName", "action", "createdAt"))

    def list_folders(self, query):
        return self.collection("FOLDER#", query, ("id", "name"))

    def folder(self, data):
        exact_fields(data, {"name"}, {"name"})
        folder_name = name(data["name"])
        if len(folder_name) > 80:
            invalid("Folder names are limited to 80 characters.")
        normalized = sha256(folder_name.casefold().encode()).hexdigest()
        folder = {"id": uid(), "name": folder_name}
        self.create([self.repo.put(self.owner, f"FOLDER#{folder['id']}", folder),
                     self.repo.put(self.owner, f"FOLDERNAME#{normalized}", {"folderId": folder["id"]}),
                     self.repo.increment(self.owner, "QUOTA#FOLDERS", MAX_FOLDERS)],
                    "That folder already exists or the workspace has reached its 40 folder limit.")
        return {"folder": folder}

    def share(self, file_id, data):
        exact_fields(data, {"expiresIn"}, {"expiresIn"})
        seconds = data["expiresIn"]
        if type(seconds) is not int or not 60 <= seconds <= 900:
            invalid("expiresIn must be 60–900 seconds.")
        row = self.get(file_id, active=True)
        key = self.verified_current(row)
        stamp, share_id = int(time.time()), uid()
        share = {"id": share_id, "fileId": file_id, "fileName": row["name"], "versionId": row["versionId"],
                 "createdAt": timestamp(stamp), "expiresAt": timestamp(stamp + seconds)}
        self.create([self.repo.put(self.owner, f"FILE#{file_id}",
                                   {**row, "revision": row["revision"] + 1}, row["revision"]),
                     self.repo.put(self.owner, f"SHARE#{share['createdAt']}#{share_id}",
                                   {**share, "expiresAtEpoch": stamp + 7 * DAY}),
                     self.repo.increment(self.owner, f"QUOTA#SHARE#{stamp // DAY}", 30, stamp + 2 * DAY),
                     self.activity("Share link created", row)],
                    "The file changed or the daily limit of 30 links was reached.")
        return {**share, "url": self.storage.presign_get(key, row["versionId"], seconds, row["name"])}

    def list_shares(self, query):
        result = self.collection("SHARE#", query, ("id", "fileId", "fileName", "versionId", "createdAt", "expiresAt"))
        for share in result["items"]:
            remaining = int(datetime.fromisoformat(share["expiresAt"]).timestamp() - time.time())
            share["url"] = self.storage.presign_get(self.key(share["fileId"]), share["versionId"], remaining,
                                                    share["fileName"]) if remaining > 0 else ""
        return result

    def analytics(self):
        files = self.files()
        active = [row for row in files if row["status"] == "active"]
        types = {}
        for row in active:
            bucket = types.setdefault(row["contentType"], {"contentType": row["contentType"], "count": 0, "size": 0})
            bucket["count"] += 1
            bucket["size"] += row["size"]
        return {"fileCount": len(active), "totalSize": sum(row["size"] for row in active),
                "deletedCount": sum(row["status"] == "deleted" for row in files), "types": list(types.values()),
                "retainedVersionCount": sum(row.get("retainedVersionCount", 0) for row in files),
                "retainedBytes": sum(row.get("retainedBytes", 0) for row in files),
                "recentActivity": self.list_activity({"limit": "5"})["items"],
                "scope": "CloudVault metadata; excludes staging, out-of-band changes and S3 overhead", "mode": "aws"}

    def notify_once(self, deduplication_key, subject, message, *, summary=False):
        if not self.publisher or (not self.notifications and not summary):
            return False
        stamp = int(time.time())
        changes = [self.repo.put(self.owner, f"NOTICE#{deduplication_key}", {"expiresAtEpoch": stamp + 14 * DAY})]
        if not summary:
            changes.append(self.repo.increment(self.owner, f"QUOTA#NOTICE#{stamp // DAY}", 5, stamp + 2 * DAY))
        try:
            self.repo.transact(changes, uid())
        except WriteConflict:
            return False
        try:
            self.publisher.publish(subject, message, deduplication_key)
        except Exception:
            # The outcome can be ambiguous. Do not send again automatically.
            log.error("notification_publish_failed")
            return False
        return True
