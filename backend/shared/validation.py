import uuid
from backend.shared.models import ALLOWED_TYPES, MAX_FILE_SIZE, ApiError


def invalid(message):
    raise ApiError(400, "INVALID_REQUEST", message)


def identifier(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            invalid("Expected a canonical UUID.")
    except (ValueError, AttributeError):
        invalid("Expected a canonical UUID.")
    return value


def name(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 180 or any((ord(c) < 32 or 127 <= ord(c) <= 159) or c in '/\\' for c in value):
        invalid("Name must contain 1–180 characters, without slashes or control characters.")
    return value.strip()


def upload(data):
    exact_fields(data, {"name", "contentType", "size", "folderId"}, {"name", "contentType", "size"})
    name(data.get("name"))
    if not isinstance(data.get("contentType"), str) or data["contentType"] not in ALLOWED_TYPES:
        invalid("Unsupported file type.")
    if type(data.get("size")) is not int or not 1 <= data["size"] <= MAX_FILE_SIZE:
        invalid("File must be between 1 byte and 5 MiB.")
    if data.get("folderId") is not None:
        identifier(data["folderId"])


def exact_fields(data, allowed, required=frozenset()):
    if not isinstance(data, dict) or set(data) - allowed or required - set(data):
        invalid("Missing required fields or unknown fields.")
