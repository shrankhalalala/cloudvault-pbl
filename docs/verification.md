# Phase 1 local verification — November 6, 2026

- Backend: 25 pytest tests pass; Python source compilation passes. Tests cover every protected route's auth, fail-closed configuration, CORS rejection, malicious upload fields, pagination, opaque/cross-file version IDs, idempotent confirmation/deletion and restoration past delete markers.
- Frontend: 8 Vitest mock-service tests pass; TypeScript, production build and Prettier checks pass. Tests verify original upload bytes survive service recreation, measured analytics reconcile, invalid uploads fail, recovery retains history, persistence failure does not commit changes, serialized mutations, link expiration, and empty reset.
- Dependency audit: npm reports 0 known vulnerabilities at installation after updating Vitest. This is a point-in-time dependency check, not a security certification.
- Browser: production preview inspected at 1440, 768 and 390 pixels; separate agent reviewed 375px mobile. All six actual navigation controls work; rename, share creation, delete/trash, delete-marker history and confirmed restoration passed. No runtime console errors or horizontal overflow were found across the reviewed pages. Native dialogs and mobile navigation support keyboard dismissal, focus trapping and restoration.
- Final design inspector: 0 failures, 2 warnings. Desktop/tablet secondary metadata remains 12px; body/control content is 13–14px. Tablet first-screen data chroma is low because the chart sits farther down its stacked layout; teal remains on its actual bars. Screenshots are [desktop](screenshots/desktop.jpg) and [mobile](screenshots/mobile.jpg).

Design review used a separate agent with the available model provider; a different-provider evaluator was unavailable. The agent-browser CLI was unavailable, so browser inspection used the design skill's temporary-profile headless Chrome/CDP fallback. No personal browser profile or AWS Console was used.

## What these checks do not prove

There are no deployed AWS resources, real presigned links, live JWT validation, DynamoDB durability, S3 event delivery, email delivery or scheduled summaries. Python in-memory and frontend IndexedDB implementations are separate. Browser mutation serialization is per service instance; simultaneous multi-tab edits are unsupported. End-to-end AWS/retry/race/reconciliation tests are Phase 2 work.

## Phase 2A local verification — November 7, 2026

- Python 3.12, 42 backend tests passed. Existing loopback tests still pass. Cloud tests use synthetic signing credentials, botocore Stubber, and in-memory substitutes for S3 and DynamoDB.
- The AWS tests cover signed header and version binding, exact-key version pagination, JWT and ownership checks, permission failure handling, upload intent replay, stale objects, races, interrupted metadata commits after S3 writes, repeatable recovery, S3 event ordering and optional SNS claims.
- Frontend, 12 tests passed. TypeScript, formatting, and the demo and cloud production builds passed. Mocked client tests cover the S3 transfer headers, authenticated confirmation, retry keys, rejected sessions, pagination and analytics.
- Chrome with a temporary profile rendered demo mode and a cloud build against synthetic OAuth/API responses. The sign-in gate rejected an invalid state, opened the authenticated workspace with cloud data, and restored an opaque version ID. The loopback server observed the browser's expected Content-Length on a File PUT. This exercised browser behavior without contacting S3 or Cognito.
- The Lambda ZIP was assembled with the pinned dependencies and tested with unzip. Python 3.12 imported all three packaged handlers. The manual acceptance checklist covers the AWS-specific behavior that local mocks cannot verify, including deployed IAM, the Cognito flow, browser-to-S3 signing/CORS, and real event and email delivery.
