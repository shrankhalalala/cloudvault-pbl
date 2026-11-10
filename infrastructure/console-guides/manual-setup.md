# CloudVault Phase 2A manual AWS Console setup

The repository includes the cloud implementation and mocked tests. Use this guide to create resources manually and run the first live acceptance test. The recommended browser origin is `http://localhost:5173` with callback and sign-out URL `http://localhost:5173/`. Use the same region for every regional resource. `ap-south-1` is the example. Substitute your actual region throughout if you choose another.

## 1. Billing and identity

Check the Billing Console for your plan, remaining credits, expiration and service eligibility. The project context gives December 5, 2026 as the credit expiry. Use the Console as the account-specific source of truth and finish the November demonstration and cleanup before access expires. A small budget alert is optional. Budget alerts do not stop requests. [AWS account plans and Free Tier](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html).

Create one Amazon Cognito user pool `cloudvault-users`. Choose Lite and a Cognito domain prefix such as `cloudvault-<ACCOUNT_ID>-<REGION>`, using Hosted UI (classic) branding. Use email or username/password sign-in, turn off self-service registration, and create one user in the Console. Complete the first-password-change flow on first sign-in. Record the user's `sub` UUID from the user's attributes.

Create a resource server named CloudVault with identifier `cloudvault` and scope name `workspace`. Create a **public SPA app client** `cloudvault-web` without a client secret. In its login pages settings, select Cognito user pool as IdP, authorization code grant only and the custom OAuth scope `cloudvault/workspace`. Set the callback and sign-out URLs exactly to `http://localhost:5173/`. Use a 15-minute access token. Set up the domain before testing the login page. The SPA sends PKCE S256 and validates OAuth state. [Cognito app client configuration](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-client-apps.html) · [Cognito PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html).

Record these values from Cognito:

| Value | Example format |
| --- | --- |
| Issuer | `https://cognito-idp.<REGION>.amazonaws.com/<USER_POOL_ID>` |
| OAuth domain | `https://<DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com` |
| Client ID | App client ID shown by Cognito |
| Owner subject | The one user's `sub` UUID |

Cognito is the extra AWS service for sign-in. AWS lists an allowance of 10,000 monthly active users for direct or social sign-in on Lite and Essentials in eligible regions. This setup uses one direct user, no paid messaging features, no SMS MFA, and no machine-to-machine grants. TOTP is an option if you want MFA. Verify the tier and account eligibility before creating the pool. [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/).

## 2. S3

Create a **general purpose** bucket `cloudvault-pbl-<ACCOUNT_ID>-<REGION>` or a globally unique equivalent. Use the actual name everywhere. Enable all four Block Public Access settings, bucket owner enforced object ownership, SSE-S3 default encryption, versioning and S3 Standard. Keep versioning enabled. Wait 15 minutes after first enabling versioning before the first upload. Keep canonical file versions through the demonstration.

In Permissions → Cross-origin resource sharing, paste the following. The origin excludes the trailing slash. Add an exact HTTPS origin only if you later host the SPA there and register its callback with Cognito.

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": [
      "Content-Type", "If-None-Match", "x-amz-server-side-encryption",
      "x-amz-expected-bucket-owner"
    ],
    "MaxAgeSeconds": 300
  }
]
```

The browser supplies Content-Length for the File body. The signature binds this value together with the required headers from the API. Test the signed PUT in the browser used for the demo. Paste the following bucket policy after substituting the bucket name. It requires encrypted transport.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::<BUCKET_NAME>", "arn:aws:s3:::<BUCKET_NAME>/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```
 Do not require conditional PUT headers on the canonical prefix because CopyObject performs the promotion and restoration. [AWS S3 conditional write policy behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html).

Add lifecycle rule `cloudvault-staging-retention` scoped to `uploads/<OWNER_SUB>/` to expire current versions after one day and permanently delete noncurrent versions after one day. Use a second prefix-scoped rule `cloudvault-staging-markers` to remove expired delete markers. Leave `owners/` outside both rules. Lifecycle timing is asynchronous. [Lifecycle with versioned buckets](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html).

## 3. DynamoDB, optional SNS, and logs

Create table `cloudvault-metadata` with string partition key `PK`, string sort key `SK`, on-demand billing and default AWS-owned encryption. Enable TTL on `expiresAtEpoch`. Leave streams and indexes off. All normal queries stay within `OWNER#<OWNER_SUB>`. The full key layout and bounds are in [architecture.md](../../docs/architecture.md).

For email, create standard SNS topic `cloudvault-notices`, add one Email subscription to an address you control and confirm it. Record its ARN. You can skip the topic and subscription while both email flags are false.

In CloudWatch Logs, precreate `/aws/lambda/cloudvault-api`, `/aws/lambda/cloudvault-processor` and, if using the summary, `/aws/lambda/cloudvault-summary`. Set each retention to **3 days**. Optional stage access logging uses `/aws/apigateway/cloudvault-http-api` with the same retention and a format containing request ID, status and latency only. Use built-in API Gateway and Lambda metrics to check errors and throttles.

## 4. IAM and Lambda ZIP

Create each Lambda execution role using the Lambda trusted entity. Add the matching inline JSON policy from [iam-policies](../iam-policies/README.md) after filling the placeholders. Attach the optional SNS publisher statement only to the roles that publish. AWS CLI credentials and an IAM user for the browser are unnecessary.

From the repository root, build one Python 3.12 ZIP for all three functions. This downloads pinned public packages and writes local files. It can run on macOS.

```sh
python3.12 -m venv .venv
pkg_dir="$(mktemp -d)"
package_dir="$(mktemp -d)"
python_package="$package_dir/cloudvault-lambda.zip"
.venv/bin/python -m pip install --target "$pkg_dir" \
  --platform manylinux2014_x86_64 --implementation cp --python-version 3.12 \
  --only-binary=:all: -r backend/requirements-lambda.txt
mkdir -p "$pkg_dir/backend"
cp backend/__init__.py "$pkg_dir/backend/"
for module in api shared processors scheduled; do
  mkdir -p "$pkg_dir/backend/$module"
  cp backend/"$module"/*.py "$pkg_dir/backend/$module/"
done
(cd "$pkg_dir" && zip -qr "$python_package" .)
unzip -tq "$python_package"
printf 'Upload %s\n' "$python_package"
```
 The ZIP root contains `backend/`, `boto3/` and `botocore/`. No virtual environment directory, local env file, tests or credentials belong in it.

## 5. Lambda functions

Create each function using Python 3.12, x86_64, **128 MiB**, the matching existing role and the indicated timeout. Upload the same ZIP through Code → Upload from → .zip file. Edit Runtime settings to set the handler.

| Function | Handler | Timeout |
| --- | --- | --- |
| `cloudvault-api` | `backend.api.handler.handler` | 20 seconds |
| `cloudvault-processor` | `backend.processors.object_created.handler` | 25 seconds |
| `cloudvault-summary` (optional) | `backend.scheduled.summary.handler` | 25 seconds |

Leave VPC, Function URLs and provisioned concurrency unset. The write-operation lease is 60 seconds. Keep API and processor timeouts below it. Set processor asynchronous retry attempts to 2 and maximum event age to 1 hour. A transient handler failure is retried by Lambda. Operators can retry confirmation in My Files → Pending after an interrupted delivery.

Set the following environment variables on all functions you create. Lambda supplies `AWS_REGION` automatically.

| Variable | Value |
| --- | --- |
| `CLOUDVAULT_MODE` | `aws` |
| `CLOUDVAULT_AUTH_MODE` | `jwt` |
| `CLOUDVAULT_BUCKET_NAME` | Actual bucket name |
| `CLOUDVAULT_TABLE_NAME` | `cloudvault-metadata` |
| `CLOUDVAULT_AWS_ACCOUNT_ID` | Your 12-digit account ID |
| `CLOUDVAULT_OWNER_SUB` | Cognito user's `sub` |
| `CLOUDVAULT_JWT_ISSUER` | Cognito issuer above |
| `CLOUDVAULT_JWT_CLIENT_ID` | Cognito app client ID |
| `CLOUDVAULT_JWT_SCOPE` | `cloudvault/workspace` |
| `CLOUDVAULT_ALLOWED_ORIGINS` | `http://localhost:5173` |
| `CLOUDVAULT_NOTIFICATIONS_ENABLED` | `true` on API and processor only if upload/recovery email is desired, otherwise `false` |
| `CLOUDVAULT_SUMMARY_ENABLED` | `true` on summary only if daily email is desired, otherwise `false` |
| `CLOUDVAULT_SNS_TOPIC_ARN` | Exact topic ARN on functions where an email flag is true |

The `CLOUDVAULT_LOCAL_TOKEN` variable belongs only to the loopback simulator. Lambda uses its execution role to obtain temporary credentials.

## 6. HTTP API with JWT authorization

Create HTTP API `cloudvault-http-api` with Lambda proxy integration `cloudvault-api`, payload version **2.0**, and auto-deploy stage `$default`. Remove any generated `$default` route. The stage and route are separate settings. Set stage throttling to **10 requests/second** and burst **20** as a starting point for one user.

Create JWT authorizer `cloudvault-jwt`. Identity source is `$request.header.Authorization`, issuer is the Cognito issuer, and audience is the app client ID. Attach the authorizer with required scope `cloudvault/workspace` on **every row marked JWT**. The app requests a custom scope without resource binding, so Cognito access tokens use the client ID that API Gateway evaluates as audience when the token has no `aud`. The Lambda also checks issuer, client ID, token use, expiry, scope and owner. [API Gateway JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html).

| Method | Route | Authorization |
| --- | --- | --- |
| GET | `/health` | None |
| GET | `/files` | JWT |
| POST | `/files/upload-url` | JWT |
| POST | `/files/confirm-upload` | JWT |
| PATCH | `/files/{id}` | JWT |
| DELETE | `/files/{id}` | JWT |
| GET | `/files/{id}/download` | JWT |
| GET | `/files/{id}/versions` | JWT |
| POST | `/files/{id}/restore` | JWT |
| POST | `/files/{id}/share` | JWT |
| GET | `/folders` | JWT |
| POST | `/folders` | JWT |
| GET | `/shares` | JWT |
| GET | `/activity` | JWT |
| GET | `/analytics` | JWT |

In HTTP API CORS set allowed origin `http://localhost:5173`, methods GET, POST, PATCH, DELETE, OPTIONS, headers `Authorization, Content-Type, Idempotency-Key`, max age 300 and credentials off. API Gateway handles preflight. The Lambda's resource-based policy must permit `apigateway.amazonaws.com` for this API and stage only. Scope each invocation source ARN to `arn:aws:execute-api:<REGION>:<ACCOUNT_ID>:<API_ID>/$default/<METHOD>/<PATH>`, substituting `*` for each route's dynamic ID and omitting the leading slash from PATH. Review Console-generated broader grants and remove redundant grants after exact routes work. Keep the API's trusted invocation boundary intact. Record the HTTPS invoke URL without an extra stage suffix. [AWS Lambda service invocation permissions](https://docs.aws.amazon.com/lambda/latest/dg/permissions-function-services.html).

### Diagnose a 401 on browser preflight

A browser preflight lists `authorization` in `Access-Control-Request-Headers` and carries no bearer token. A 401 with a Bearer challenge and the Gateway's `{"message":"Unauthorized"}` body indicates a Gateway authorization rejection. The Lambda handler returns an empty 204 for allowed-origin OPTIONS before checking JWT claims. CORS headers can be present on the Gateway's 401.

In API Gateway → your HTTP API → Routes, check which route matches OPTIONS. If access logs are already enabled, look up the failing request ID and inspect its route key. Check for explicit OPTIONS routes with JWT attached, a JWT-protected `$default` route, or an authorized `ANY` catch-all. Keep the `$default` **stage** and JWT authorization on each protected operation.

- For the explicit route setup in this guide, remove any unintended authenticated catch-all after confirming the table above covers the routes you use. With API-level CORS enabled, Gateway handles preflight when no authorized route captures it.
- If you intentionally keep an authenticated catch-all, add `OPTIONS /{proxy+}` with **Authorization: None** and attach the existing API Lambda proxy integration (payload 2.0). Any more specific OPTIONS route must also allow unauthenticated preflight. Check whether the existing Lambda invocation grant covers this route before choosing this option. [AWS guidance on CORS and authorized catch-alls](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-cors.html).

After the approved route change is active on the stage, verify that OPTIONS with the configured origin, requested method, and requested headers returns 2xx without a token. Verify that an unauthenticated GET to a protected route still returns 401 and that a signed-in browser can load the workspace. The existing Lambda code already handles OPTIONS, so a code redeployment is unnecessary for this Gateway fix.

## 7. Events

In the processor Lambda, add the S3 trigger for your bucket with event **PUT** (`s3:ObjectCreated:Put`) and prefix `uploads/<OWNER_SUB>/`. Confirm that the resource-based permission allows only `s3.amazonaws.com`, this bucket ARN and this source account. The copy writes to `owners/` and therefore never re-enters the staging handler. Test a small upload, then inspect its activity and the processor's log.

For daily email, use EventBridge → Scheduler → **Scheduled rule (legacy)**. Create rule `cloudvault-daily-summary` on the default bus with cron `cron(0 12 * * ? *)` (12:00 UTC, 17:30 IST), target `cloudvault-summary`, and input **matched event**. The code expects `source: aws.events` and the event's UTC time. Scope the function resource policy to `events.amazonaws.com` and `arn:aws:events:<REGION>:<ACCOUNT_ID>:rule/cloudvault-daily-summary`. Set the target retry policy to two attempts and maximum event age to one hour. Start with the rule disabled until the SNS subscription and function are ready. [Creating scheduled EventBridge rules](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-schedule.html).

## 8. Frontend and live acceptance

```sh
cd frontend
npm ci
test -f .env.local || cp .env.example .env.local
```

Set `VITE_CLOUDVAULT_MODE=aws` in `.env.local`, set `VITE_CLOUDVAULT_API_BASE_URL` to your HTTPS invoke URL, and configure `VITE_COGNITO_DOMAIN` equal to your HTTPS OAuth domain, `VITE_COGNITO_CLIENT_ID` equal to the public client ID, `VITE_COGNITO_SCOPE=cloudvault/workspace`, and `VITE_COGNITO_REDIRECT_URI=http://localhost:5173/`. Run `npm run dev -- --strictPort` and open `http://localhost:5173/`. Stop another server on that port first. To build a cloud bundle, run `npm run build`. Vite settings are public build metadata. Keep tokens and secrets out of env files.

1. Confirm `GET /health` responds and anonymous requests to the protected routes receive 401/403. In cloud mode sign in as the one configured Cognito owner. Validate that a different user cannot access the workspace if you choose to test with a second temporary user.
2. Upload a small `.txt` file. Check the staging PUT returns success and the current file appears once. Browser devtools can show request status without sharing the signed URL or access token. Check both S3 prefixes and DynamoDB metadata manually in their consoles.
3. Create a folder, move and rename the file, download it, and compare bytes. Share for one minute and check expiry. Soft delete does not revoke a previously issued version-pinned URL.
4. Move the file to trash, inspect the delete marker, restore the retained content, and verify it downloads. Repeat the same restore to confirm one restored activity. If an operation was interrupted, retry the same action after the 60-second lease.
5. Check activity and analytics against metadata. If email is enabled, confirm a single upload and recovery notice. Run the summary with a Lambda test payload `{"source":"aws.events","time":"<CURRENT_UTC_TIMESTAMP>"}` and check the email. A second invocation for the same UTC schedule day reuses the existing notification claim.

## Cost controls and cleanup

S3 charges can include staging and noncurrent bytes, requests and data transfer. DynamoDB uses on-demand reads/writes, including transactions. Lambda, API Gateway, SNS, EventBridge and CloudWatch have their own usage dimensions. The app caps each object at 5 MiB, the workspace at 200 upload intents and 40 folders, share issuance at 30 per UTC day, and upload/recovery email attempts at 5 per UTC day plus the optional summary. These are application bounds. Check Billing for actual usage.

After exporting any files you need, clean up in this order:

1. Disable and delete the EventBridge rule and its target. Remove S3 event notifications. Disable API access by deleting the dedicated API and stages. Allow in-flight invocations to settle.
2. Delete the three project functions you created and their project-specific invocation permissions. Delete the optional SNS email subscription and topic.
3. In S3 show versions and empty **all** versions and delete markers under both prefixes. Abort incomplete multipart uploads if any exist. Delete the bucket after it is empty. Removing current objects alone leaves retained storage.
4. Delete the DynamoDB table and any manual exports or backups you made. Delete the Cognito domain, app client and user pool, disabling deletion protection if the pool has it.
5. Delete only the project's IAM roles and inline policies, log groups, alarms, and any optional budget or hosted frontend created for this demo. Recheck the region and Billing after reporting has caught up.
