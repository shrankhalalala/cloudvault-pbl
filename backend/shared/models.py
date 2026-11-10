"""Phase 1 domain models. JSON uses camelCase; version IDs are opaque strings."""
from dataclasses import asdict, dataclass
from typing import Literal

MAX_FILE_SIZE = 5 * 1024 * 1024
ALLOWED_TYPES = frozenset({"application/pdf", "text/plain", "text/csv", "application/json", "image/png", "image/jpeg"})


@dataclass
class FileRecord:
    id: str
    name: str
    contentType: str
    size: int
    folderId: str | None
    status: Literal["pending", "active", "deleted"]
    createdAt: str
    updatedAt: str

    def json(self):
        return asdict(self)


@dataclass
class Version:
    versionId: str
    size: int
    createdAt: str
    isLatest: bool
    isDeleteMarker: bool = False


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
