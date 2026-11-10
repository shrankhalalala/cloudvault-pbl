"""Lazy AWS client wiring. The local server imports none of these clients."""
from functools import lru_cache

import boto3
from botocore.config import Config

from backend.shared.aws_adapters import DynamoRepository, S3Store, SnsPublisher
from backend.shared.aws_config import config
from backend.shared.cloud_service import CloudService


@lru_cache(maxsize=1)
def cloud_service():
    settings = config()
    client_config = Config(signature_version="v4", connect_timeout=2, read_timeout=4,
                           retries={"total_max_attempts": 2})
    s3_config = client_config.merge(Config(signature_version="s3v4", s3={"addressing_style": "virtual"},
                                          retries={"total_max_attempts": 1}))
    s3 = S3Store(boto3.client("s3", region_name=settings.region, config=s3_config),
                 settings.bucket, settings.account_id)
    repo = DynamoRepository(boto3.client("dynamodb", region_name=settings.region, config=client_config),
                            settings.table)
    publisher = None
    if settings.notifications or settings.summaries:
        sns_config = client_config.merge(Config(retries={"total_max_attempts": 1}))
        publisher = SnsPublisher(boto3.client("sns", region_name=settings.region, config=sns_config), settings.topic)
    return CloudService(repo, s3, settings.owner, publisher, settings.notifications)
