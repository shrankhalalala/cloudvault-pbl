"""Runtime configuration. AWS clients are constructed only inside cloud entry points."""
import os
from dataclasses import dataclass
from functools import lru_cache

from backend.shared.models import ApiError
from backend.shared.validation import identifier


@dataclass(frozen=True)
class CloudConfig:
    region: str
    bucket: str
    table: str
    owner: str
    issuer: str
    client_id: str
    scope: str
    account_id: str
    topic: str
    notifications: bool
    summaries: bool


@lru_cache(maxsize=1)
def config():
    values = [
        os.getenv(key, "").strip() for key in (
            "AWS_REGION", "CLOUDVAULT_BUCKET_NAME", "CLOUDVAULT_TABLE_NAME",
            "CLOUDVAULT_OWNER_SUB", "CLOUDVAULT_JWT_ISSUER", "CLOUDVAULT_JWT_CLIENT_ID",
            "CLOUDVAULT_JWT_SCOPE", "CLOUDVAULT_AWS_ACCOUNT_ID",
        )
    ]
    if not all(values) or not values[4].startswith("https://") or not (
        len(values[7]) == 12 and values[7].isascii() and values[7].isdigit()
    ):
        raise ApiError(503, "CLOUD_NOT_CONFIGURED", "Cloud runtime configuration is incomplete.")
    try:
        identifier(values[3])
    except ApiError:
        raise ApiError(503, "CLOUD_NOT_CONFIGURED", "The owner subject must be a UUID.") from None
    topic = os.getenv("CLOUDVAULT_SNS_TOPIC_ARN", "").strip()
    notifications = os.getenv("CLOUDVAULT_NOTIFICATIONS_ENABLED") == "true"
    summaries = os.getenv("CLOUDVAULT_SUMMARY_ENABLED") == "true"
    if (notifications or summaries) and not topic.startswith(f"arn:aws:sns:{values[0]}:{values[7]}:"):
        raise ApiError(503, "CLOUD_NOT_CONFIGURED", "Configure the SNS topic in the same account and region.")
    return CloudConfig(*values, topic, notifications, summaries)
