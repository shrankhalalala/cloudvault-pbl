"""API Gateway HTTP API v2 entry point with an independent local simulator."""
import hmac
import json
import logging
import os
import re
from dataclasses import asdict
from backend.shared.models import ApiError
from backend.shared.service import LocalService
from backend.shared.validation import exact_fields, invalid

service = LocalService()
log = logging.getLogger(__name__)


def handler(event, context):
    request_id = getattr(context, "aws_request_id", "local")
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    origin = headers.get("origin")
    allowed = [v.strip() for v in os.getenv("CLOUDVAULT_ALLOWED_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(",") if v.strip() and v.strip() != "*"]
    response_headers = {"Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Origin"}
    if origin in allowed:
        response_headers["Access-Control-Allow-Origin"] = origin
    def response(status, body=None):
        return {"statusCode": status, "headers": response_headers, "body": "" if body is None else json.dumps(body)}
    try:
        method = event.get("requestContext", {}).get("http", {}).get("method", "")
        path = event.get("rawPath", "")
        if origin and origin not in allowed:
            raise ApiError(403, "ORIGIN_DENIED", "Origin is not allowed.")
        if method == "OPTIONS":
            response_headers.update({"Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type,Idempotency-Key"})
            return response(204)
        mode = os.getenv("CLOUDVAULT_MODE", "local")
        auth_mode = os.getenv("CLOUDVAULT_AUTH_MODE", "local-token")
        if path == "/health" and method == "GET":
            return response(200, {"status": "ok", "mode": mode, "awsConnected": None if mode == "aws" else False})
        if mode == "local" and auth_mode == "local-token":
            token = os.getenv("CLOUDVAULT_LOCAL_TOKEN", "")
            if len(token) < 32:
                raise ApiError(503, "AUTH_NOT_CONFIGURED", "Configure a local token of at least 32 characters.")
            if not hmac.compare_digest(headers.get("authorization", "").encode("utf-8"), ("Bearer " + token).encode("utf-8")):
                raise ApiError(401, "UNAUTHORIZED", "A valid local bearer token is required.")
        elif mode != "aws" or auth_mode != "jwt":
            raise ApiError(503, "AUTH_NOT_CONFIGURED", "Configure an explicit authentication mode.")
        body = event.get("body") or "{}"
        if event.get("isBase64Encoded") or len(body) > 16384:
            invalid("Request body must be plain JSON under 16 KiB.")
        try:
            data = json.loads(body)
        except (ValueError, TypeError):
            invalid("Malformed JSON.")
        if not isinstance(data, dict):
            invalid("JSON body must be an object.")
        query = event.get("queryStringParameters") or {}
        if mode == "aws":
            from backend.api.cloud import dispatch
            status, result = dispatch(event, method, path, data, query, headers)
            return response(status, result)
        if method == "POST" and path == "/files/upload-url":
            return response(201, service.request_upload(data))
        if method == "POST" and path == "/files/confirm-upload":
            return response(200, service.confirm(data))
        if method == "GET" and path == "/files":
            return response(200, service.list_files(query))
        if method == "GET" and path == "/activity":
            return response(200, service.paginate(service.activities, query, "activity"))
        if method == "GET" and path == "/analytics":
            return response(200, service.analytics())
        match = re.fullmatch(r"/files/([^/]+)(?:/(download|versions|restore|share))?", path)
        if match:
            file_id, action = match.groups()
            file = service.get(file_id)
            if method == "PATCH" and not action:
                return response(200, service.patch(file_id, data))
            if method == "DELETE" and not action:
                service.delete(file_id)
                return response(204)
            if method == "GET" and action == "versions":
                return response(200, service.paginate([asdict(v) for v in service.versions[file_id]], query, "versions:" + file_id))
            if method == "POST" and action == "restore":
                return response(200, service.restore(file_id, data))
            if method == "GET" and action == "download":
                service.get(file_id, active=True)
                raise ApiError(501, "OBJECT_TRANSFER_UNAVAILABLE", "Use the frontend demo for local content downloads.")
            if method == "POST" and action == "share":
                service.get(file_id, active=True)
                exact_fields(data, {"expiresIn"}, {"expiresIn"})
                if type(data["expiresIn"]) is not int or not 60 <= data["expiresIn"] <= 900:
                    invalid("expiresIn must be 60–900 seconds.")
                raise ApiError(501, "OBJECT_TRANSFER_UNAVAILABLE", "S3 sharing will be implemented in Phase 2.")
        raise ApiError(404, "ROUTE_NOT_FOUND", "Route not found.")
    except ApiError as error:
        return response(error.status, {"error": {"code": error.code, "message": error.message, "requestId": request_id}})
    except Exception:
        log.error("unexpected_api_failure")
        return response(500, {"error": {"code": "INTERNAL_ERROR", "message": "Unexpected server error.", "requestId": request_id}})
