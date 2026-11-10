# CloudVault execution policies

Use separate Lambda roles named `cloudvault-api-role`, `cloudvault-processor-role` and `cloudvault-summary-role`. Each role trusts only Lambda through `sts:AssumeRole`. Substitute `<REGION>`, `<ACCOUNT_ID>`, `<BUCKET_NAME>` and `<OWNER_SUB>` in the policy for that role. The templates assume the table and function names in the [Console guide](../console-guides/manual-setup.md).

| Role | S3 | DynamoDB | CloudWatch |
| --- | --- | --- | --- |
| API | List versions on both owner prefixes. Read object metadata and versions on both. Put staging objects and copy into the canonical prefix. Create canonical delete markers. | GetItem, Query, PutItem, UpdateItem on the owner's partition. | Write streams in `/aws/lambda/cloudvault-api`. |
| Processor | List versions and read metadata on both owner prefixes. Copy verified uploads into the canonical prefix. | GetItem, PutItem, UpdateItem on the owner's partition. | Write streams in `/aws/lambda/cloudvault-processor`. |
| Summary | None | Query and PutItem on the owner's partition. | Write streams in `/aws/lambda/cloudvault-summary`. |

Attach [sns-publish-optional.json](sns-publish-optional.json) to API and processor only for upload/recovery email. Attach it to the summary role only if the daily summary is enabled. SNS publishes to the one named topic.

The object and log-stream patterns cover only the named prefix or group. Precreate log groups to avoid `logs:CreateLogGroup` on wider resources. The API has no `s3:DeleteObjectVersion` permission. DynamoDB transactions use the underlying PutItem and UpdateItem authorizations for the writes in this code. [AWS transaction authorization](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).

Configure invocation separately in Lambda function resource policies. Scope API invocation to the designated HTTP API and stage, processor invocation to the one bucket and its account, and summary invocation to the one EventBridge rule. These execution policies grant no direct function invocation.
