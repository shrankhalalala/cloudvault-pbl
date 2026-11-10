"""Daily UTC storage summary. One SNS publish attempt per scheduled day."""
import logging
import os
from datetime import datetime, timezone

log = logging.getLogger(__name__)
log.setLevel(logging.INFO)


def handler(event, context):
    if os.getenv("CLOUDVAULT_MODE") != "aws" or os.getenv("CLOUDVAULT_SUMMARY_ENABLED") != "true":
        return {"enabled": False}
    from backend.shared.runtime import cloud_service

    if event.get("source") != "aws.events":
        raise ValueError("Expected an EventBridge scheduled event.")
    try:
        day = datetime.fromisoformat(event["time"]).astimezone(timezone.utc).date().isoformat()
    except (KeyError, ValueError, TypeError):
        raise ValueError("Expected a valid schedule time.") from None
    try:
        service = cloud_service()
        stats = service.analytics()
        published = service.notify_once(
            f"summary#{day}", "CloudVault daily storage summary",
            f"Schedule day (UTC): {day}\nActive files: {stats['fileCount']}\n"
            f"Active bytes: {stats['totalSize']}\nFiles in trash: {stats['deletedCount']}\n"
            f"Recorded retained bytes: {stats['retainedBytes']}\nSource: CloudVault workspace metadata.",
            summary=True,
        )
    except Exception:
        raise RuntimeError("summary_retry_required") from None
    log.info("summary_completed published=%s", published)
    return {"enabled": True, "published": published}
