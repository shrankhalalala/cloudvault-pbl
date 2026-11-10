"""Narrow boto3 adapters. Each client can be replaced with a botocore stub."""
from decimal import Decimal
from urllib.parse import quote

from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
from botocore.exceptions import ClientError

from backend.shared.models import ApiError


class WriteConflict(Exception):
    """A conditional DynamoDB write lost a race."""


def missing(error):
    return error.response["Error"]["Code"] in {"404", "NoSuchKey", "NoSuchVersion", "NotFound", "405", "MethodNotAllowed"}


class S3Store:
    def __init__(self, client, bucket, account_id):
        self.client = client
        self.base = {"Bucket": bucket, "ExpectedBucketOwner": account_id}
        self.upload_headers = {"If-None-Match": "*", "x-amz-server-side-encryption": "AES256",
                               "x-amz-expected-bucket-owner": account_id}

    def presign_put(self, key, content_type, size, expires):
        # ExpectedBucketOwner is an S3 request header and must also be signed.
        return self.client.generate_presigned_url(
            "put_object", Params={**self.base, "Key": key, "ContentType": content_type,
                                  "ContentLength": size, "IfNoneMatch": "*", "ServerSideEncryption": "AES256"},
            ExpiresIn=expires, HttpMethod="PUT",
        )

    def head(self, key, version_id=None):
        args = {"VersionId": version_id} if version_id is not None else {}
        try:
            return self.client.head_object(**self.base, Key=key, **args)
        except ClientError as error:
            if version_id is not None and error.response["Error"]["Code"] in {"405", "MethodNotAllowed"}:
                return {"DeleteMarker": True}
            if missing(error):
                return None
            if version_id is not None and error.response["Error"]["Code"] in {"403", "AccessDenied"}:
                # S3 can return 403 for an absent object when ListBucket is
                # unavailable. List exact-key versions to distinguish it from
                # a genuine denial without granting general bucket listing.
                cursor = None
                for _ in range(10):
                    result = self.list_versions(key, cursor, 1000)
                    match = next((entry for entry in result["items"] if entry["versionId"] == version_id), None)
                    if match:
                        if match["isDeleteMarker"]:
                            return {"DeleteMarker": True}
                        break
                    cursor = result["nextCursor"]
                    if not cursor:
                        return None
            raise

    def presign_get(self, key, version_id, expires, filename="download"):
        # GET links must work in a plain browser navigation, which cannot attach
        # ExpectedBucketOwner. The bucket is verified by HEAD before signing.
        return self.client.generate_presigned_url(
            "get_object", Params={"Bucket": self.base["Bucket"], "Key": key, "VersionId": version_id,
                                  "ResponseContentDisposition": "attachment; filename*=UTF-8''" + quote(filename, safe=""),
                                  "ResponseContentType": "application/octet-stream",
                                  "ResponseCacheControl": "private, no-store"},
            ExpiresIn=expires, HttpMethod="GET",
        )

    def list_versions(self, key, cursor=None, limit=25):
        args = {"KeyMarker": cursor[0], "VersionIdMarker": cursor[1]} if cursor else {}
        result = self.client.list_object_versions(**self.base, Prefix=key, MaxKeys=limit, **args)
        entries = [
            {"versionId": row["VersionId"], "size": row.get("Size", 0),
             "createdAt": row["LastModified"].isoformat(), "isLatest": row["IsLatest"],
             "isDeleteMarker": marker}
            for field, marker in (("Versions", False), ("DeleteMarkers", True))
            for row in result.get(field, []) if row["Key"] == key
        ]
        entries.sort(key=lambda row: (row["isLatest"], row["createdAt"]), reverse=True)
        next_cursor = None
        if result.get("IsTruncated") and result.get("NextKeyMarker") == key and result.get("NextVersionIdMarker"):
            next_cursor = [result["NextKeyMarker"], result["NextVersionIdMarker"]]
        return {"items": entries, "nextCursor": next_cursor}

    def create_delete_marker(self, key):
        result = self.client.delete_object(**self.base, Key=key)
        if not result.get("DeleteMarker") or not versioned(result.get("VersionId")):
            raise ApiError(503, "VERSIONING_REQUIRED", "S3 bucket versioning must be enabled.")
        return result["VersionId"]

    def copy_version(self, key, version_id, operation_id, *, source_key=None, content_type):
        try:
            result = self.client.copy_object(
                **self.base, Key=key, CopySource={"Bucket": self.base["Bucket"], "Key": source_key or key,
                                                 "VersionId": version_id},
                ExpectedSourceBucketOwner=self.base["ExpectedBucketOwner"], MetadataDirective="REPLACE",
                Metadata={"cloudvault-operation": operation_id}, ContentType=content_type,
                ServerSideEncryption="AES256",
            )
        except ClientError as error:
            if missing(error):
                raise ApiError(409, "OBJECT_MISSING", "The selected content version is unavailable.") from None
            raise
        if not versioned(result.get("VersionId")):
            raise ApiError(503, "VERSIONING_REQUIRED", "S3 bucket versioning must be enabled.")
        return result


def versioned(version_id):
    return isinstance(version_id, str) and version_id not in {"", "null"}


_serializer = TypeSerializer()
_deserializer = TypeDeserializer()


def attributes(values):
    return {key: _serializer.serialize(value) for key, value in values.items()}


def deserialize(values):
    item = {key: _deserializer.deserialize(value) for key, value in values.items()}
    return {key: int(value) if isinstance(value, Decimal) else value for key, value in item.items()}


class DynamoRepository:
    def __init__(self, client, table):
        self.client = client
        self.table = table

    @staticmethod
    def key(owner, sort_key):
        return {"PK": f"OWNER#{owner}", "SK": sort_key}

    def get(self, owner, sort_key):
        result = self.client.get_item(TableName=self.table, Key=attributes(self.key(owner, sort_key)),
                                      ConsistentRead=True)
        return deserialize(result["Item"]) if "Item" in result else None

    def get_file(self, owner, file_id):
        return self.get(owner, f"FILE#{file_id}")

    def query(self, owner, prefix, *, limit=100, start=None, descending=False):
        args = {"ExclusiveStartKey": attributes(self.key(owner, start))} if start else {}
        result = self.client.query(
            TableName=self.table, ConsistentRead=True, ScanIndexForward=not descending, Limit=limit,
            KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
            ExpressionAttributeValues=attributes({":pk": f"OWNER#{owner}", ":prefix": prefix}), **args,
        )
        last = result.get("LastEvaluatedKey")
        return [deserialize(row) for row in result["Items"]], last["SK"]["S"] if last else None

    def all(self, owner, prefix, maximum):
        start = None
        count = 0
        while True:
            rows, start = self.query(owner, prefix, start=start)
            for row in rows:
                count += 1
                if count > maximum:
                    raise ApiError(503, "WORKSPACE_LIMIT", "The workspace exceeds the configured demo limit.")
                yield row
            if not start:
                return

    def put(self, owner, sort_key, row, expected_revision=None):
        args = {"TableName": self.table, "Item": attributes({**row, **self.key(owner, sort_key)})}
        if expected_revision is None:
            args["ConditionExpression"] = "attribute_not_exists(SK)"
        else:
            args.update(ConditionExpression="#rev = :old", ExpressionAttributeNames={"#rev": "revision"},
                        ExpressionAttributeValues=attributes({":old": expected_revision}))
        return {"Put": args}

    def transact(self, changes, operation_id):
        try:
            self.client.transact_write_items(TransactItems=changes, ClientRequestToken=operation_id)
        except ClientError as error:
            code = error.response["Error"]["Code"]
            reasons = error.response.get("CancellationReasons", [])
            if code == "TransactionConflictException" or (
                code == "TransactionCanceledException"
                and any(reason.get("Code") in {"ConditionalCheckFailed", "TransactionConflict"} for reason in reasons)
            ):
                raise WriteConflict from None
            raise

    def increment(self, owner, sort_key, limit, expires_at=None):
        args = {
            "TableName": self.table, "Key": attributes(self.key(owner, sort_key)),
            "UpdateExpression": "ADD #n :one",
            "ConditionExpression": "attribute_not_exists(#n) OR #n < :limit",
            "ExpressionAttributeNames": {"#n": "count"},
            "ExpressionAttributeValues": attributes({":one": 1, ":limit": limit}),
        }
        if expires_at is not None:
            args["UpdateExpression"] = "SET expiresAtEpoch = :expires ADD #n :one"
            args["ExpressionAttributeValues"].update(attributes({":expires": expires_at}))
        return {"Update": args}


class SnsPublisher:
    def __init__(self, client, topic):
        self.client = client
        self.topic = topic

    def publish(self, subject, message, deduplication_key):
        self.client.publish(TopicArn=self.topic, Subject=subject, Message=message,
                            MessageAttributes={"operation": {"DataType": "String", "StringValue": deduplication_key}})
