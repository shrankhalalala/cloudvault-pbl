from collections import defaultdict
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import boto3
import pytest
from botocore.config import Config
from botocore.stub import Stubber

from backend.api import cloud
from backend.api.handler import handler
from backend.processors import object_created
from backend.scheduled import summary
from backend.shared.aws_adapters import DynamoRepository, S3Store, WriteConflict, attributes, deserialize
from backend.shared.cloud_service import CloudService, LEASE_SECONDS
from backend.shared.models import ApiError
from backend.shared.service import uid

OWNER = "5684087b-30c7-4833-899e-78ee1db00ea1"
ACCOUNT = "123456789012"
BUCKET = "cloudvault-test-only"
REGION = "ap-south-1"
SETTINGS = SimpleNamespace(owner=OWNER, bucket=BUCKET, issuer="https://issuer.invalid",
                           client_id="client", scope="cloudvault/workspace")


@pytest.fixture
def s3():
    # Explicit synthetic credentials never read the host credential chain.
    client = boto3.client("s3", region_name=REGION, aws_access_key_id="TESTACCESSKEY",
                          aws_secret_access_key="test-secret", aws_session_token="test-session",
                          config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))
    return S3Store(client, BUCKET, ACCOUNT)


def test_presigned_upload_and_download_bind_expected_parameters(s3):
    key = f"uploads/{OWNER}/{uid()}/content"
    url = urlsplit(s3.presign_put(key, "text/plain", 17, 300))
    params = parse_qs(url.query)
    assert url.scheme == "https" and url.netloc == f"{BUCKET}.s3.{REGION}.amazonaws.com"
    assert params["X-Amz-Expires"] == ["300"]
    assert set(params["X-Amz-SignedHeaders"][0].split(";")) == {
        "host", "content-length", "content-type", "if-none-match", "x-amz-server-side-encryption",
        "x-amz-expected-bucket-owner",
    }
    download = parse_qs(urlsplit(s3.presign_get(key, "opaque+/=", 60, "résumé.txt")).query)
    assert download["versionId"] == ["opaque+/="]
    assert download["response-content-disposition"] == ["attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt"]
    assert download["X-Amz-Expires"] == ["60"]


def test_s3_exact_key_version_pages_and_delete_marker(s3):
    stamp = datetime.now(timezone.utc)
    with Stubber(s3.client) as stub:
        stub.add_response("list_object_versions", {
            "Versions": [{"Key": "key", "VersionId": "old+/", "Size": 4, "IsLatest": False, "LastModified": stamp},
                         {"Key": "key-extra", "VersionId": "foreign", "Size": 8, "IsLatest": True, "LastModified": stamp}],
            "DeleteMarkers": [{"Key": "key", "VersionId": "marker", "IsLatest": True, "LastModified": stamp}],
            "IsTruncated": True, "NextKeyMarker": "key", "NextVersionIdMarker": "old+/",
        }, {**s3.base, "Prefix": "key", "MaxKeys": 25})
        result = s3.list_versions("key")
        assert [v["versionId"] for v in result["items"]] == ["marker", "old+/"]
        stub.add_response("list_object_versions", {"IsTruncated": False},
                          {**s3.base, "Prefix": "key", "MaxKeys": 25,
                           "KeyMarker": "key", "VersionIdMarker": "old+/"})
        assert s3.list_versions("key", result["nextCursor"])["items"] == []
        stub.add_client_error("head_object", service_error_code="405", http_status_code=405,
                              expected_params={**s3.base, "Key": "key", "VersionId": "marker"})
        assert s3.head("key", "marker") == {"DeleteMarker": True}


def test_copy_keeps_opaque_source_and_encryption(s3):
    with Stubber(s3.client) as stub:
        stub.add_response("copy_object", {"VersionId": "new/version"}, {
            **s3.base, "Key": "canonical", "CopySource": {"Bucket": BUCKET, "Key": "staging", "VersionId": "opaque+/="},
            "ExpectedSourceBucketOwner": ACCOUNT, "MetadataDirective": "REPLACE",
            "Metadata": {"cloudvault-operation": "op"}, "ContentType": "text/plain",
            "ServerSideEncryption": "AES256",
        })
        assert s3.copy_version("canonical", "opaque+/=", "op", source_key="staging",
                               content_type="text/plain")["VersionId"] == "new/version"


def test_dynamo_query_and_conflict_translation():
    client = boto3.client("dynamodb", region_name=REGION, aws_access_key_id="TEST", aws_secret_access_key="test")
    repo = DynamoRepository(client, "test-table")
    key = attributes(repo.key(OWNER, "FILE#previous"))
    with Stubber(client) as stub:
        stub.add_response("query", {"Items": [attributes({"size": 5})], "LastEvaluatedKey": key}, {
            "TableName": "test-table", "ConsistentRead": True, "ScanIndexForward": False, "Limit": 10,
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": attributes({":pk": f"OWNER#{OWNER}", ":prefix": "FILE#"}),
            "ExclusiveStartKey": key,
        })
        assert repo.query(OWNER, "FILE#", limit=10, start="FILE#previous", descending=True) == ([{"size": 5}], "FILE#previous")
        change = repo.put(OWNER, "FILE#x", {"revision": 2}, expected_revision=1)
        stub.add_client_error("transact_write_items", service_error_code="TransactionCanceledException",
                              modeled_fields={"CancellationReasons": [{"Code": "ConditionalCheckFailed"}]},
                              expected_params={"TransactItems": [change], "ClientRequestToken": "op"})
        with pytest.raises(WriteConflict):
            repo.transact([change], "op")


class MemoryRepo(DynamoRepository):
    def __init__(self):
        super().__init__(None, "table")
        self.rows = {}
        self.fail_next_finalization = False

    def get(self, owner, sort_key):
        return deepcopy(self.rows.get((f"OWNER#{owner}", sort_key)))

    def query(self, owner, prefix, *, limit=100, start=None, descending=False):
        keys = sorted((sk for pk, sk in self.rows if pk == f"OWNER#{owner}" and sk.startswith(prefix)),
                      reverse=descending)
        if start:
            keys = [sk for sk in keys if (sk < start if descending else sk > start)]
        return [self.get(owner, key) for key in keys[:limit]], keys[limit-1] if len(keys) > limit else None

    def transact(self, changes, operation_id):
        next_rows = deepcopy(self.rows)
        for change in changes:
            if "Put" in change:
                write = change["Put"]
                row = deserialize(write["Item"])
                key = row["PK"], row["SK"]
                previous = self.rows.get(key)
                if "ExpressionAttributeValues" in write:
                    old_revision = deserialize(write["ExpressionAttributeValues"])[":old"]
                    if not previous or previous["revision"] != old_revision:
                        raise WriteConflict
                elif previous:
                    raise WriteConflict
                if self.fail_next_finalization and key[1].startswith("FILE#") and row.get("processingState") == "ready":
                    self.fail_next_finalization = False
                    raise TimeoutError("simulated unavailable DynamoDB")
                next_rows[key] = row
            else:
                update = change["Update"]
                key = update["Key"]["PK"]["S"], update["Key"]["SK"]["S"]
                count = self.rows.get(key, {}).get("count", 0)
                if count >= int(update["ExpressionAttributeValues"][":limit"]["N"]):
                    raise WriteConflict
                next_rows[key] = {"count": count + 1}
        self.rows = next_rows


class MemoryS3:
    upload_headers = {"If-None-Match": "*", "x-amz-server-side-encryption": "AES256",
                      "x-amz-expected-bucket-owner": ACCOUNT}

    def __init__(self):
        self.objects = defaultdict(list)
        self.copies = self.deletes = 0

    def presign_put(self, key, *_):
        return f"https://example.invalid/{key}"

    def presign_get(self, key, version, *_):
        return f"https://example.invalid/{key}?version={version}"

    def add(self, key, *, marker=False, size=17, metadata=None, content_type="text/plain"):
        version = uid()
        self.objects[key].insert(0, {"VersionId": version, "DeleteMarker": marker, "ContentLength": size,
                                     "ContentType": content_type, "ServerSideEncryption": "AES256",
                                     "Metadata": metadata or {}})
        return version

    def list_versions(self, key, cursor=None, limit=25):
        return {"items": [{"versionId": row["VersionId"], "isDeleteMarker": row["DeleteMarker"],
                           "isLatest": i == 0, "size": row["ContentLength"]}
                          for i, row in enumerate(self.objects[key][:limit])], "nextCursor": None}

    def head(self, key, version_id=None):
        return next((row for row in self.objects[key] if row["VersionId"] == version_id), None)

    def create_delete_marker(self, key):
        self.deletes += 1
        return self.add(key, marker=True, size=0)

    def copy_version(self, key, version_id, operation_id, *, source_key=None, content_type):
        self.copies += 1
        source = self.head(source_key or key, version_id)
        return {"VersionId": self.add(key, size=source["ContentLength"], content_type=content_type,
                                      metadata={"cloudvault-operation": operation_id})}

@pytest.fixture
def workspace():
    return CloudService(MemoryRepo(), MemoryS3(), OWNER)


def pending(workspace, **overrides):
    result = workspace.request_upload({"name": "notes.txt", "contentType": "text/plain", "size": 17, **overrides})
    assert result["requiredHeaders"]["If-None-Match"] == "*"
    assert "/uploads/" in result["uploadUrl"]
    return result["file"]["id"]


def uploaded(workspace):
    file_id = pending(workspace)
    workspace.storage.add(workspace.staging(file_id))
    workspace.confirm({"fileId": file_id})
    return file_id


def test_extension_size_and_ownership(workspace):
    with pytest.raises(ApiError, match="extension"):
        pending(workspace, name="script.html")
    file_id = pending(workspace)
    workspace.storage.add(workspace.staging(file_id), size=18)
    with pytest.raises(ApiError, match="does not match"):
        workspace.confirm({"fileId": file_id})
    assert workspace.get(file_id)["processingState"] == "rejected"
    assert workspace.storage.copies == 0
    foreign = CloudService(workspace.repo, workspace.storage, uid())
    with pytest.raises(ApiError) as error:
        foreign.download(file_id)
    assert error.value.status == 404


def test_upload_processing_deduplicates_and_ignores_out_of_order(workspace):
    file_id = pending(workspace)
    staging = workspace.staging(file_id)
    old = workspace.storage.add(staging)
    current = workspace.storage.add(staging)
    assert workspace.confirmed_upload(file_id, old, "01")["status"] == "pending"
    row = workspace.confirmed_upload(file_id, current, "02")
    assert row["uploadVersionId"] == current
    assert workspace.confirmed_upload(file_id, old, "01")["versionId"] == row["versionId"]
    workspace.confirm({"fileId": file_id})
    assert workspace.storage.copies == 1
    assert len(workspace.list_activity({})["items"]) == 1


def test_copy_and_delete_reconcile_after_metadata_failure(workspace, monkeypatch):
    clock = [1_800_000_000]
    monkeypatch.setattr("backend.shared.cloud_service.time.time", lambda: clock[0])
    file_id = pending(workspace)
    workspace.storage.add(workspace.staging(file_id))
    workspace.repo.fail_next_finalization = True
    with pytest.raises(TimeoutError):
        workspace.confirm({"fileId": file_id})
    with pytest.raises(ApiError) as error:
        workspace.confirm({"fileId": file_id})
    assert error.value.code == "OPERATION_IN_PROGRESS"
    clock[0] += LEASE_SECONDS + 1
    workspace.confirm({"fileId": file_id})
    assert workspace.storage.copies == 1
    workspace.repo.fail_next_finalization = True
    operation = uid()
    with pytest.raises(TimeoutError):
        workspace.delete(file_id, operation)
    clock[0] += LEASE_SECONDS + 1
    workspace.delete(file_id, operation)
    workspace.delete(file_id, operation)
    assert workspace.storage.deletes == 1
    assert workspace.analytics()["retainedBytes"] == 17
    assert len(workspace.list_activity({})["items"]) == 2


def test_restore_over_delete_marker_is_repeatable(workspace):
    file_id = uploaded(workspace)
    original = workspace.get(file_id)["versionId"]
    delete_key = uid()
    workspace.delete(file_id, delete_key)
    marker = workspace.get(file_id)["versionId"]
    with pytest.raises(ApiError) as invalid_version:
        workspace.restore(file_id, {"versionId": marker}, uid())
    assert invalid_version.value.status == 400
    retry_key = uid()
    assert workspace.restore(file_id, {"versionId": original}, retry_key)["file"]["status"] == "active"
    workspace.restore(file_id, {"versionId": original}, retry_key)
    workspace.delete(file_id, delete_key)  # Replay must not re-delete restored content.
    assert workspace.get(file_id)["status"] == "active"
    assert workspace.storage.copies == 2
    assert workspace.storage.deletes == 1
    assert workspace.analytics()["retainedVersionCount"] == 1


def test_stale_or_missing_current_does_not_issue_links(workspace):
    file_id = uploaded(workspace)
    workspace.storage.create_delete_marker(workspace.key(file_id))
    for call in (lambda: workspace.download(file_id), lambda: workspace.share(file_id, {"expiresIn": 60})):
        with pytest.raises(ApiError, match="differs"):
            call()
    version = workspace.get(file_id)["versionId"]
    workspace.restore(file_id, {"versionId": version})
    assert workspace.download(file_id)["versionId"] != version


def test_folder_move_and_file_pagination(workspace):
    first, second = uploaded(workspace), uploaded(workspace)
    folder_id = workspace.folder({"name": "Project"})["folder"]["id"]
    with pytest.raises(ApiError):
        workspace.folder({"name": "PROJECT"})
    workspace.patch(first, {"name": "renamed.txt", "folderId": folder_id})
    result = workspace.list_files({"limit": "1"})
    assert result["nextCursor"] and result["items"][0]["id"] == first
    assert workspace.list_files({"limit": "1", "cursor": result["nextCursor"]})["items"][0]["id"] == second
    assert workspace.list_files({"folderId": folder_id})["items"][0]["id"] == first


def test_jwt_is_required_before_sdk_wiring(monkeypatch):
    monkeypatch.setenv("CLOUDVAULT_MODE", "aws")
    monkeypatch.setenv("CLOUDVAULT_AUTH_MODE", "jwt")
    monkeypatch.setattr(cloud, "config", lambda: SETTINGS)
    def fail():
        pytest.fail("AWS clients initialized before authorization")
    monkeypatch.setattr(cloud, "cloud_service", fail)
    event = {"version": "2.0", "rawPath": "/files", "requestContext": {"http": {"method": "GET"}}}
    assert handler(event, None)["statusCode"] == 401
    claims = {"iss": SETTINGS.issuer, "client_id": SETTINGS.client_id, "token_use": "access",
              "exp": "9999999999", "scope": SETTINGS.scope, "sub": uid()}
    event["requestContext"]["authorizer"] = {"jwt": {"claims": claims}}
    assert handler(event, None)["statusCode"] == 403
    for invalid_claim in ({"exp": "0"}, {"token_use": "id"}, {"client_id": "other"}, {"scope": "openid"}):
        claims.update(sub=OWNER, **invalid_claim)
        assert handler(event, None)["statusCode"] == 401
        claims.update(exp="9999999999", token_use="access", client_id=SETTINGS.client_id, scope=SETTINGS.scope)


def test_s3_event_and_summary_send_at_most_one_attempt(workspace, monkeypatch):
    from backend.shared import aws_config, runtime

    published = []
    workspace.publisher = SimpleNamespace(publish=lambda *args: published.append(args))
    workspace.notifications = True
    monkeypatch.setenv("CLOUDVAULT_MODE", "aws")
    monkeypatch.setenv("CLOUDVAULT_SUMMARY_ENABLED", "true")
    monkeypatch.setattr(aws_config, "config", lambda: SETTINGS)
    monkeypatch.setattr(runtime, "cloud_service", lambda: workspace)
    file_id = pending(workspace)
    key = workspace.staging(file_id)
    version = workspace.storage.add(key)
    put = {"eventSource": "aws:s3", "eventName": "ObjectCreated:Put", "s3": {
        "bucket": {"name": BUCKET}, "object": {"key": key.replace("/", "%2F"), "versionId": version, "sequencer": "AB"},
    }}
    copy = {**put, "eventName": "ObjectCreated:Copy"}
    object_created.handler({"Records": [copy, put, put]}, None)
    object_created.handler({"Records": [put]}, None)
    assert workspace.storage.copies == 1
    assert len(workspace.list_activity({})["items"]) == 1
    assert len(published) == 1
    event = {"source": "aws.events", "time": "2026-11-07T12:00:00Z"}
    assert summary.handler(event, None)["published"] is True
    assert summary.handler(event, None)["published"] is False
    assert len(published) == 2
    monkeypatch.setenv("CLOUDVAULT_SUMMARY_ENABLED", "false")
    assert summary.handler({}, None) == {"enabled": False}


def test_upload_intent_retries_do_not_duplicate_quota_or_extend_grant(workspace, monkeypatch):
    clock = [1_800_000_000]
    monkeypatch.setattr("backend.shared.cloud_service.time.time", lambda: clock[0])
    data = {"name": "notes.txt", "contentType": "text/plain", "size": 17}
    retry = uid()
    first = workspace.request_upload(data, retry)
    clock[0] += 10
    second = workspace.request_upload(data, retry)
    assert second["file"]["id"] == first["file"]["id"]
    assert second["expiresIn"] == first["expiresIn"] - 10
    assert workspace.repo.get(OWNER, "QUOTA#FILES")["count"] == 1
    with pytest.raises(ApiError, match="different upload"):
        workspace.request_upload({**data, "size": 18}, retry)
    clock[0] += 300
    with pytest.raises(ApiError) as expired:
        workspace.request_upload(data, retry)
    assert expired.value.code == "UPLOAD_INTENT_EXPIRED"


def test_recovery_after_copy_response_then_failed_commit(workspace, monkeypatch):
    clock = [1_800_000_000]
    monkeypatch.setattr("backend.shared.cloud_service.time.time", lambda: clock[0])
    file_id = uploaded(workspace)
    source = workspace.get(file_id)["versionId"]
    workspace.delete(file_id)
    workspace.repo.fail_next_finalization = True
    with pytest.raises(TimeoutError):
        workspace.restore(file_id, {"versionId": source}, uid())
    clock[0] += LEASE_SECONDS + 1
    # Browser reload lost its retry key, but the pending operation is durable.
    restored = workspace.restore(file_id, {"versionId": source}, uid())
    assert restored["file"]["status"] == "active"
    assert workspace.storage.copies == 2
    assert [a["action"] for a in workspace.list_activity({})["items"]].count("Version restored") == 1


def test_missing_version_versus_permission_denial(s3):
    args = {**s3.base, "Key": "key", "VersionId": "missing"}
    listing = {**s3.base, "Prefix": "key", "MaxKeys": 1000}
    with Stubber(s3.client) as stub:
        stub.add_client_error("head_object", service_error_code="403", http_status_code=403, expected_params=args)
        stub.add_response("list_object_versions", {"IsTruncated": False}, listing)
        assert s3.head("key", "missing") is None
        stub.add_client_error("head_object", service_error_code="403", http_status_code=403, expected_params=args)
        stub.add_client_error("list_object_versions", service_error_code="AccessDenied", http_status_code=403,
                              expected_params=listing)
        from botocore.exceptions import ClientError
        with pytest.raises(ClientError) as error:
            s3.head("key", "missing")
        assert error.value.response["Error"]["Code"] == "AccessDenied"


def test_authenticated_gateway_routes_preserve_cloud_contract(workspace, monkeypatch):
    import json

    monkeypatch.setenv("CLOUDVAULT_MODE", "aws")
    monkeypatch.setenv("CLOUDVAULT_AUTH_MODE", "jwt")
    monkeypatch.setenv("CLOUDVAULT_ALLOWED_ORIGINS", "http://localhost:5173")
    monkeypatch.setattr(cloud, "config", lambda: SETTINGS)
    monkeypatch.setattr(cloud, "cloud_service", lambda: workspace)
    claims = {"iss": SETTINGS.issuer, "client_id": SETTINGS.client_id, "token_use": "access",
              "exp": "9999999999", "scope": SETTINGS.scope, "sub": OWNER}

    def call(method, path, data=None, query=None, headers=None):
        response = handler({
            "version": "2.0", "rawPath": path,
            "requestContext": {"http": {"method": method}, "authorizer": {"jwt": {"claims": claims}}},
            "headers": {"Origin": "http://localhost:5173", **(headers or {})},
            "body": json.dumps(data or {}), "queryStringParameters": query,
        }, None)
        assert response["headers"]["Access-Control-Allow-Origin"] == "http://localhost:5173"
        return response["statusCode"], json.loads(response["body"]) if response["body"] else None

    status, result = call("POST", "/folders", {"name": "Reports"})
    assert status == 201
    status, intent = call("POST", "/files/upload-url", {
        "name": "notes.txt", "contentType": "text/plain", "size": 17, "folderId": result["folder"]["id"],
    }, headers={"Idempotency-Key": uid()})
    assert status == 201 and intent["mode"] == "aws"
    file_id = intent["file"]["id"]
    workspace.storage.add(workspace.staging(file_id))
    status, confirmed = call("POST", "/files/confirm-upload", {"fileId": file_id})
    assert status == 200 and confirmed["file"]["status"] == "active"
    status, share = call("POST", f"/files/{file_id}/share", {"expiresIn": 60})
    assert status == 201 and share["versionId"] == confirmed["file"]["currentVersionId"]
    assert call("GET", "/shares")[1]["items"][0]["id"] == share["id"]
    assert call("GET", "/files", query={"status": "all"})[1]["items"][0]["id"] == file_id
    assert call("DELETE", f"/files/{file_id}", headers={"Idempotency-Key": uid()}) == (204, None)
    assert call("GET", f"/files/{file_id}/versions")[1]["items"][0]["isDeleteMarker"]
    assert call("POST", f"/files/{file_id}/restore", {"versionId": share["versionId"]})[0] == 200
    assert call("GET", "/analytics")[1]["fileCount"] == 1
    path = f"/files/{file_id}/download"
    current_status, current = call("GET", path)
    historical_status, historical = call("GET", path, query={"versionId": share["versionId"]})
    assert current_status == historical_status == 200
    assert historical["versionId"] == share["versionId"] != current["versionId"]
    assert parse_qs(urlsplit(historical["url"]).query)["version"] == [share["versionId"]]


def test_share_claim_rejects_a_racing_delete(workspace, monkeypatch):
    file_id = uploaded(workspace)
    verified_current = workspace.verified_current

    def concurrent_delete(row):
        key = verified_current(row)
        workspace.delete(file_id)
        return key

    monkeypatch.setattr(workspace, "verified_current", concurrent_delete)
    with pytest.raises(ApiError, match="file changed"):
        workspace.share(file_id, {"expiresIn": 60})
    assert workspace.list_shares({})["items"] == []
    assert workspace.get(file_id)["status"] == "deleted"


@pytest.mark.parametrize(("path", "requested_method", "requested_headers"), [
    ("/files", "GET", "authorization"),
    ("/folders", "GET", "authorization"),
    ("/shares", "GET", "authorization"),
    ("/activity", "GET", "authorization"),
    ("/analytics", "GET", "authorization"),
    ("/files/upload-url", "POST", "authorization,content-type,idempotency-key"),
    ("/files/00000000-0000-4000-8000-000000000001", "DELETE", "authorization,idempotency-key"),
])
def test_cloud_preflight_needs_no_jwt_or_aws_clients(monkeypatch, path, requested_method, requested_headers):
    origin = "http://localhost:5173"
    monkeypatch.setenv("CLOUDVAULT_MODE", "aws")
    monkeypatch.setenv("CLOUDVAULT_AUTH_MODE", "jwt")
    monkeypatch.setenv("CLOUDVAULT_ALLOWED_ORIGINS", origin)

    def unexpected_call(*args):
        pytest.fail("OPTIONS reached cloud configuration, JWT authorization, or AWS clients")

    monkeypatch.setattr(cloud, "config", unexpected_call)
    monkeypatch.setattr(cloud, "authorize", unexpected_call)
    monkeypatch.setattr(cloud, "cloud_service", unexpected_call)
    result = handler({
        "version": "2.0",
        "routeKey": "OPTIONS /{proxy+}",
        "rawPath": path,
        "requestContext": {"http": {"method": "OPTIONS"}},
        "headers": {
            "origin": origin,
            "access-control-request-method": requested_method,
            "access-control-request-headers": requested_headers,
        },
    }, None)

    assert result["statusCode"] == 204
    assert result["body"] == ""
    headers = result["headers"]
    assert headers["Access-Control-Allow-Origin"] == origin
    assert requested_method in headers["Access-Control-Allow-Methods"].split(",")
    assert set(requested_headers.split(",")) <= set(headers["Access-Control-Allow-Headers"].lower().split(","))
    assert "www-authenticate" not in {name.lower() for name in headers}


@pytest.mark.parametrize("path", ["/files", "/folders", "/shares", "/activity", "/analytics"])
def test_cross_origin_dashboard_get_requires_verified_owner_claims(workspace, monkeypatch, path):
    import json

    origin = "http://localhost:5173"
    monkeypatch.setenv("CLOUDVAULT_MODE", "aws")
    monkeypatch.setenv("CLOUDVAULT_AUTH_MODE", "jwt")
    monkeypatch.setenv("CLOUDVAULT_ALLOWED_ORIGINS", origin)
    monkeypatch.setattr(cloud, "config", lambda: SETTINGS)
    monkeypatch.setattr(cloud, "cloud_service", lambda: workspace)
    event = {
        "version": "2.0",
        "routeKey": f"GET {path}",
        "rawPath": path,
        "requestContext": {"http": {"method": "GET"}},
        "headers": {"origin": origin},
    }

    unauthenticated = handler(event, None)
    assert unauthenticated["statusCode"] == 401
    assert json.loads(unauthenticated["body"])["error"]["code"] == "UNAUTHORIZED"
    assert unauthenticated["headers"]["Access-Control-Allow-Origin"] == origin

    event["requestContext"]["authorizer"] = {"jwt": {"claims": {
        "iss": SETTINGS.issuer,
        "client_id": SETTINGS.client_id,
        "token_use": "access",
        "exp": "9999999999",
        "scope": SETTINGS.scope,
        "sub": OWNER,
    }}}
    authenticated = handler(event, None)
    assert authenticated["statusCode"] == 200
    assert authenticated["headers"]["Access-Control-Allow-Origin"] == origin
    if path == "/analytics":
        assert json.loads(authenticated["body"])["fileCount"] == 0
    else:
        assert json.loads(authenticated["body"]) == {"items": [], "nextCursor": None}
