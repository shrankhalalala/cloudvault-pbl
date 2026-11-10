"""In-memory contract simulator. No S3 URLs or AWS side effects are produced."""
from dataclasses import asdict
from datetime import datetime, timezone
import base64
import uuid
from backend.shared.models import ApiError, FileRecord, Version
from backend.shared.validation import exact_fields, identifier, invalid, name, upload


def now():
    return datetime.now(timezone.utc).isoformat()


def uid():
    return str(uuid.uuid4())


def object_key(owner_id: str, file_id: str):
    # Internal only; never concatenate client names or accept keys from clients.
    return f"owners/{identifier(owner_id)}/files/{identifier(file_id)}/content"


class LocalService:
    def __init__(self):
        self.files = {}
        self.versions = {}
        self.activities = []
        self.folders = set()

    def record(self, action, file):
        self.activities.insert(0, {"id": uid(), "action": action, "fileId": file.id, "fileName": file.name, "createdAt": now()})

    def get(self, file_id, active=False):
        identifier(file_id)
        file = self.files.get(file_id)
        if not file:
            raise ApiError(404, "NOT_FOUND", "File not found.")
        if active and file.status != "active":
            raise ApiError(409, "INVALID_STATE", "File is not active.")
        return file

    def folder(self, folder_id):
        if folder_id is not None and identifier(folder_id) not in self.folders:
            invalid("Folder does not exist. Phase 1 backend only supports the root folder.")

    def request_upload(self, data):
        upload(data)
        self.folder(data.get("folderId"))
        stamp, file_id = now(), uid()
        file = FileRecord(file_id, name(data["name"]), data["contentType"], data["size"], data.get("folderId"), "pending", stamp, stamp)
        self.files[file_id] = file
        self.versions[file_id] = []
        return {"file": file.json(), "uploadUrl": None, "expiresIn": 300, "requiredHeaders": {"Content-Type": file.contentType}, "mode": "local", "nextStep": "Local simulator has no object transfer; confirm-upload simulates verification."}

    def confirm(self, data):
        exact_fields(data, {"fileId"}, {"fileId"})
        file = self.get(data["fileId"])
        if file.status == "pending":
            file.status, file.updatedAt = "active", now()
            self.versions[file.id].insert(0, Version(uid(), file.size, now(), True))
            self.record("uploaded", file)
        elif file.status != "active":
            raise ApiError(409, "INVALID_STATE", "Deleted files cannot be confirmed.")
        return {"file": file.json(), "mode": "local"}

    def patch(self, file_id, data):
        exact_fields(data, {"name", "folderId"})
        if not data:
            invalid("Provide name or folderId.")
        file = self.get(file_id, active=True)
        new_name = name(data["name"]) if "name" in data else file.name
        self.folder(data.get("folderId", file.folderId))
        file.name, file.folderId, file.updatedAt = new_name, data.get("folderId", file.folderId), now()
        self.record("updated", file)
        return {"file": file.json()}

    def delete(self, file_id):
        file = self.get(file_id)
        if file.status == "deleted":
            return
        if file.status != "active":
            raise ApiError(409, "INVALID_STATE", "Pending uploads cannot be soft deleted.")
        for version in self.versions[file.id]:
            version.isLatest = False
        self.versions[file.id].insert(0, Version(uid(), 0, now(), True, True))
        file.status, file.updatedAt = "deleted", now()
        self.record("deleted", file)

    def restore(self, file_id, data):
        exact_fields(data, {"versionId"}, {"versionId"})
        if not isinstance(data["versionId"], str) or not 1 <= len(data["versionId"]) <= 1024:
            invalid("versionId must be a nonempty opaque string.")
        file = self.get(file_id)
        source = next((v for v in self.versions[file_id] if v.versionId == data["versionId"]), None)
        if not source:
            raise ApiError(404, "VERSION_NOT_FOUND", "Version not found for this file.")
        if source.isDeleteMarker:
            invalid("Select a retained content version, not a delete marker.")
        for version in self.versions[file_id]:
            version.isLatest = False
        self.versions[file_id].insert(0, Version(uid(), source.size, now(), True))
        file.status, file.size, file.updatedAt = "active", source.size, now()
        self.record("restored", file)
        return {"file": file.json(), "mode": "local"}

    def paginate(self, items, query, scope):
        try:
            limit = int(query.get("limit", "25"))
            if not 1 <= limit <= 100:
                invalid("limit must be 1–100.")
            offset = 0
            if query.get("cursor"):
                decoded = base64.urlsafe_b64decode(query["cursor"].encode()).decode()
                cursor_scope, raw_offset = decoded.rsplit(":", 1)
                if cursor_scope != scope:
                    invalid("Cursor does not match this query.")
                offset = int(raw_offset)
                if offset < 0:
                    invalid("Invalid cursor.")
        except (ValueError, UnicodeError, TypeError):
            invalid("Invalid pagination parameters.")
        end = offset + limit
        cursor = base64.urlsafe_b64encode(f"{scope}:{end}".encode()).decode() if end < len(items) else None
        return {"items": items[offset:end], "nextCursor": cursor}

    def list_files(self, query):
        status = query.get("status", "active")
        if status not in {"active", "pending", "deleted"}:
            invalid("Unknown status.")
        sort = query.get("sort", "updatedAt")
        if sort not in {"name", "size", "updatedAt"} or query.get("order", "desc") not in {"asc", "desc"}:
            invalid("Unknown sort or order.")
        folder = query.get("folderId")
        if folder and folder != "root":
            identifier(folder)
        rows = [f.json() for f in self.files.values() if f.status == status and query.get("q", "").casefold() in f.name.casefold() and (folder is None or f.folderId == (None if folder == "root" else folder))]
        rows.sort(key=lambda f: (f[sort].casefold() if sort == "name" else f[sort], f["id"]), reverse=query.get("order", "desc") == "desc")
        scope = repr(sorted((k, v) for k, v in query.items() if k not in {"cursor", "limit"}))
        return self.paginate(rows, query, scope)

    def analytics(self):
        active = [f for f in self.files.values() if f.status == "active"]
        types = {}
        for file in active:
            row = types.setdefault(file.contentType, {"contentType": file.contentType, "count": 0, "size": 0})
            row["count"] += 1
            row["size"] += file.size
        return {"fileCount": len(active), "totalSize": sum(f.size for f in active), "deletedCount": sum(f.status == "deleted" for f in self.files.values()), "types": list(types.values()), "recentActivity": self.activities[:5], "scope": "current active metadata only; excludes retained versions", "mode": "local"}
