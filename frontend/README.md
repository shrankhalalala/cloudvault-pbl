# CloudVault frontend

The six workspace pages share the same React layout in demo and cloud modes.

`VITE_CLOUDVAULT_MODE=demo` uses browser IndexedDB. The label identifies the demo workspace. Local share links work within the originating browser and origin. Local file mutations are serialized within one service instance. Simultaneous multi-tab edits are unsupported.

`VITE_CLOUDVAULT_MODE=aws` uses the API Gateway endpoint and Cognito public SPA client configured in `.env.local`. The authorization code flow uses PKCE and state. The access token stays in memory, and only the short-lived pending PKCE transaction uses session storage. Uploads go directly to S3 with the signed headers and then confirm through the API. Downloads and shares open short-lived S3 capabilities. Cloud errors are shown in the workspace without loading demo data.

The mode must be explicit. The older `VITE_API_MODE=cloud` / `demo` and `VITE_API_BASE_URL` settings still work when their respective `VITE_CLOUDVAULT_*` setting is absent. Restart Vite after editing environment values. Open the exact hostname and port configured in the Cognito redirect URI.

See the [repository README](../README.md) for local commands and the [Console guide](../infrastructure/console-guides/manual-setup.md) for AWS values and live acceptance.
