"""Process S3 staging PUTs. Confirmation and notifications share durable state."""
import logging
import os
import re
from urllib.parse import unquote_plus

from backend.shared.models import ApiError

log = logging.getLogger(__name__)
log.setLevel(logging.INFO)
EXPECTED_REJECTIONS = {"NOT_FOUND", "UPLOAD_NOT_FOUND", "OBJECT_INVALID", "VERSIONING_REQUIRED"}


def handler(event, context):
    if os.getenv("CLOUDVAULT_MODE") != "aws":
        return {"processed": 0}
    from backend.shared.aws_config import config
    from backend.shared.runtime import cloud_service

    settings = config()
    processed = 0
    for record in event.get("Records", []):
        if record.get("eventSource") != "aws:s3" or record.get("eventName") != "ObjectCreated:Put":
            continue
        s3 = record.get("s3", {})
        if s3.get("bucket", {}).get("name") != settings.bucket:
            continue
        obj = s3.get("object", {})
        key = unquote_plus(obj.get("key", ""))
        match = re.fullmatch(rf"uploads/{settings.owner}/([0-9a-f-]{{36}})/content", key)
        version, sequence = obj.get("versionId"), obj.get("sequencer")
        if not match or not isinstance(version, str) or not 1 <= len(version) <= 1024 or version == "null":
            continue
        if not isinstance(sequence, str) or not re.fullmatch(r"[a-fA-F0-9]{1,128}", sequence):
            continue
        file_id = match[1]
        from backend.shared.validation import identifier
        try:
            identifier(file_id)
        except ApiError:
            continue
        service = cloud_service()
        try:
            row = service.confirmed_upload(file_id, version, sequence)
        except ApiError as error:
            if error.code in EXPECTED_REJECTIONS:
                log.info("staging_event_rejected code=%s", error.code)
                continue
            raise RuntimeError("staging_event_retry_required") from None
        except Exception:
            raise RuntimeError("staging_event_retry_required") from None
        if row.get("uploadVersionId") == version:
            service.notify_once(f"upload#{file_id}", "CloudVault upload", "A file upload was verified and stored.")
            processed += 1
    log.info("staging_batch_processed count=%d", processed)
    return {"processed": processed}
