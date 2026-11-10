"""HTTP API payload v2 cloud routes. The gateway validates JWT signatures."""
import logging
import re
import time

from botocore.exceptions import BotoCoreError, ClientError

from backend.shared.aws_config import config
from backend.shared.models import ApiError
from backend.shared.runtime import cloud_service

log = logging.getLogger(__name__)


def authorize(event, settings):
    try:
        authorizer = (event.get("requestContext") or {}).get("authorizer") or {}
        claims = (authorizer.get("jwt") or {}).get("claims") or {}
        valid = (
            event.get("version") == "2.0" and claims.get("iss") == settings.issuer
            and claims.get("client_id") == settings.client_id and claims.get("token_use") == "access"
            and int(claims.get("exp", 0)) > time.time()
            and settings.scope in claims.get("scope", "").split()
        )
    except (ValueError, TypeError, AttributeError):
        valid = False
    if not valid:
        raise ApiError(401, "UNAUTHORIZED", "Sign in with the configured CloudVault identity.")
    if claims.get("sub") != settings.owner:
        raise ApiError(403, "OWNER_REQUIRED", "This identity cannot access the workspace.")


def dispatch(event, method, path, data, query, headers):
    settings = config()
    authorize(event, settings)
    service = cloud_service()
    try:
        return routes(service, method, path, data, query, headers.get("idempotency-key"))
    except (ClientError, BotoCoreError) as error:
        if isinstance(error, ClientError):
            log.error("aws_request_failed operation=%s code=%s", error.operation_name,
                      error.response.get("Error", {}).get("Code", "Unknown"))
        else:
            log.error("aws_request_failed type=%s", type(error).__name__)
        raise ApiError(503, "STORAGE_UNAVAILABLE", "Cloud storage is temporarily unavailable. Retry shortly.") from None


def routes(service, method, path, data, query, request_key):
    if path == "/files/upload-url" and method == "POST":
        return 201, service.request_upload(data, request_key)
    if path == "/files/confirm-upload" and method == "POST":
        return 200, service.confirm(data)
    if path == "/files" and method == "GET":
        return 200, service.list_files(query)
    if path == "/folders":
        if method == "GET":
            return 200, service.list_folders(query)
        if method == "POST":
            return 201, service.folder(data)
    if path == "/shares" and method == "GET":
        return 200, service.list_shares(query)
    if path == "/activity" and method == "GET":
        return 200, service.list_activity(query)
    if path == "/analytics" and method == "GET":
        return 200, service.analytics()
    match = re.fullmatch(r"/files/([^/]+)(?:/(download|versions|restore|share))?", path)
    if match:
        file_id, action = match.groups()
        if method == "PATCH" and not action:
            return 200, service.patch(file_id, data)
        if method == "DELETE" and not action:
            service.delete(file_id, request_key)
            return 204, None
        if method == "GET" and action == "download":
            return 200, service.download(file_id, query.get("versionId"))
        if method == "GET" and action == "versions":
            return 200, service.versions(file_id, query)
        if method == "POST" and action == "restore":
            return 200, service.restore(file_id, data, request_key)
        if method == "POST" and action == "share":
            return 201, service.share(file_id, data)
    raise ApiError(404, "ROUTE_NOT_FOUND", "Route not found.")
