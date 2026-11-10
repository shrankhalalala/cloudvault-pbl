import json
from uuid import uuid4
import pytest
from backend.api import handler as api
from backend.shared.models import ApiError, MAX_FILE_SIZE
from backend.shared.service import LocalService, object_key

TOKEN = "test-local-token-with-at-least-32-characters"


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.setenv("CLOUDVAULT_LOCAL_TOKEN", TOKEN)
    monkeypatch.setenv("CLOUDVAULT_MODE", "local")
    monkeypatch.setenv("CLOUDVAULT_AUTH_MODE", "local-token")
    monkeypatch.setattr(api, "service", LocalService())


def call(method, path, body=None, headers=None, query=None):
    result = api.handler({"rawPath": path, "requestContext": {"http": {"method": method}}, "headers": headers if headers is not None else {"authorization": "Bearer " + TOKEN}, "body": json.dumps(body or {}), "queryStringParameters": query or {}}, None)
    return result["statusCode"], json.loads(result["body"]) if result["body"] else None


def uploaded():
    status, body = call("POST", "/files/upload-url", {"name": "notes.txt", "contentType": "text/plain", "size": 42})
    assert status == 201 and body["uploadUrl"] is None
    file_id = body["file"]["id"]
    assert call("POST", "/files/confirm-upload", {"fileId": file_id})[0] == 200
    return file_id


@pytest.mark.parametrize("method,path", [("POST", "/files/upload-url"), ("POST", "/files/confirm-upload"), ("GET", "/files"), ("GET", "/activity"), ("GET", "/analytics"), *[(method, "/files/" + str(uuid4()) + action) for method, action in [("GET", "/download"), ("PATCH", ""), ("DELETE", ""), ("GET", "/versions"), ("POST", "/restore"), ("POST", "/share")]]])
def test_protected_routes(method, path):
    assert call(method, path, headers={})[0] == 401


@pytest.mark.parametrize("field,value", [("size", True), ("size", 0), ("size", MAX_FILE_SIZE + 1), ("name", "../escape"), ("name", "bad\x00name"), ("contentType", "text/html"), ("objectKey", "untrusted")])
def test_upload_rejects_invalid(field, value):
    data = {"name": "report.pdf", "size": 5, "contentType": "application/pdf", field: value}
    assert call("POST", "/files/upload-url", data)[0] == 400


def test_confirm_delete_restore_and_marker():
    file_id = uploaded()
    call("POST", "/files/confirm-upload", {"fileId": file_id})
    assert len(api.service.activities) == 1
    original = call("GET", f"/files/{file_id}/versions")[1]["items"][0]["versionId"]
    assert call("DELETE", f"/files/{file_id}")[0] == 204
    call("DELETE", f"/files/{file_id}")
    versions = call("GET", f"/files/{file_id}/versions")[1]["items"]
    assert len(versions) == 2 and versions[0]["isDeleteMarker"]
    assert call("POST", f"/files/{file_id}/restore", {"versionId": versions[0]["versionId"]})[0] == 400
    assert call("POST", f"/files/{file_id}/restore", {"versionId": original})[1]["file"]["status"] == "active"
    assert sum(v.isLatest for v in api.service.versions[file_id]) == 1
    assert call("GET", "/analytics")[1]["totalSize"] == 42


def test_opaque_version_and_cross_file_rejected():
    a, b = uploaded(), uploaded()
    api.service.versions[a][0].versionId = "opaque+/=.value"
    assert call("POST", f"/files/{a}/restore", {"versionId": "opaque+/=.value"})[0] == 200
    assert call("POST", f"/files/{b}/restore", {"versionId": "opaque+/=.value"})[0] == 404


def test_pagination_and_filters():
    uploaded(); uploaded()
    page = call("GET", "/files", query={"limit": "1"})[1]
    assert len(page["items"]) == 1 and page["nextCursor"]
    assert len(call("GET", "/files", query={"limit": "1", "cursor": page["nextCursor"]})[1]["items"]) == 1
    assert call("GET", "/files", query={"cursor": "!bad"})[0] == 400
    assert call("GET", "/files", query={"limit": "0"})[0] == 400
    assert call("GET", "/files", query={"q": "missing"})[1]["items"] == []


def test_cors_and_fail_closed(monkeypatch):
    assert call("GET", "/files", headers={"origin": "https://evil.example"})[0] == 403
    monkeypatch.setenv("CLOUDVAULT_LOCAL_TOKEN", "")
    assert call("GET", "/files")[0] == 503
    monkeypatch.setenv("CLOUDVAULT_MODE", "aws")
    assert call("GET", "/files")[0] == 503
    assert call("GET", "/health")[0] == 200


def test_no_s3_transfer_claim():
    file_id = uploaded()
    assert call("GET", f"/files/{file_id}/download")[0] == 501
    assert call("POST", f"/files/{file_id}/share", {"expiresIn": 300})[0] == 501


def test_keys_and_atomic_patch():
    file_id = uploaded()
    assert object_key(str(uuid4()), file_id).endswith(f"/files/{file_id}/content")
    assert call("PATCH", f"/files/{file_id}", {"name": "changed.txt", "folderId": str(uuid4())})[0] == 400
    assert api.service.files[file_id].name == "notes.txt"
    assert call("GET", "/files/not-a-uuid/versions")[0] == 400


def test_json_type_validation_and_unicode_auth():
    assert call("POST", "/files/upload-url", {"name": "file.txt", "size": 2, "contentType": []})[0] == 400
    assert call("GET", "/files", headers={"authorization": "Bearer invalid-\u2603"})[0] == 401
    result = api.handler({"rawPath": "/files/upload-url", "requestContext": {"http": {"method": "POST"}}, "headers": {"Authorization": "Bearer " + TOKEN}, "body": "{broken"}, None)
    assert result["statusCode"] == 400
