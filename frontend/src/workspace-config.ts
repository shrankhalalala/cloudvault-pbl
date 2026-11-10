export type AwsSettings = {
  endpoint: string;
  domain: string;
  clientId: string;
  scope: string;
  redirect: string;
};

type WorkspaceConfig =
  | { mode: "demo" }
  | { mode: "aws"; settings: AwsSettings }
  | { mode: "error"; title: string; message: string };

type WorkspaceEnv = Partial<
  Record<
    | "VITE_CLOUDVAULT_MODE"
    | "VITE_CLOUDVAULT_API_BASE_URL"
    | "VITE_API_MODE"
    | "VITE_API_BASE_URL"
    | "VITE_COGNITO_DOMAIN"
    | "VITE_COGNITO_CLIENT_ID"
    | "VITE_COGNITO_SCOPE"
    | "VITE_COGNITO_REDIRECT_URI",
    string
  >
>;

function parseUrl(name: string, value: string) {
  try {
    const url = new URL(value);
    if (!url.username && !url.password && !url.search && !url.hash) return url;
  } catch {
    // Report the variable name without including its value.
  }
  throw new Error(
    `${name} must be an absolute URL without credentials, a query, or a fragment.`,
  );
}

export function resolveWorkspaceConfig(
  env: WorkspaceEnv,
  page: Pick<Location, "origin" | "pathname">,
): WorkspaceConfig {
  // Keep the old names for existing installs. A defined primary value always
  // wins, even when invalid, so a stale legacy demo setting cannot mask it.
  const legacyMode = env.VITE_API_MODE?.trim();
  const mode =
    env.VITE_CLOUDVAULT_MODE?.trim() ??
    (legacyMode === "cloud"
      ? "aws"
      : legacyMode === "demo"
        ? "demo"
        : undefined);
  if (mode === "demo") return { mode };
  if (mode !== "aws") {
    return {
      mode: "error",
      title: "Choose a workspace mode",
      message:
        "Set VITE_CLOUDVAULT_MODE to aws or demo in frontend/.env.local.",
    };
  }

  const apiKey =
    env.VITE_CLOUDVAULT_API_BASE_URL !== undefined ||
    env.VITE_API_BASE_URL === undefined
      ? "VITE_CLOUDVAULT_API_BASE_URL"
      : "VITE_API_BASE_URL";
  const required = {
    [apiKey]: env[apiKey]?.trim() ?? "",
    VITE_COGNITO_DOMAIN: env.VITE_COGNITO_DOMAIN?.trim() ?? "",
    VITE_COGNITO_CLIENT_ID: env.VITE_COGNITO_CLIENT_ID?.trim() ?? "",
    VITE_COGNITO_SCOPE: env.VITE_COGNITO_SCOPE?.trim() ?? "",
    VITE_COGNITO_REDIRECT_URI: env.VITE_COGNITO_REDIRECT_URI?.trim() ?? "",
  };
  try {
    const missing = Object.keys(required).filter((key) => !required[key]);
    if (missing.length)
      throw new Error(`Missing settings: ${missing.join(", ")}.`);
    const endpoint = parseUrl(apiKey, required[apiKey]);
    const domain = parseUrl(
      "VITE_COGNITO_DOMAIN",
      required.VITE_COGNITO_DOMAIN,
    );
    const redirect = parseUrl(
      "VITE_COGNITO_REDIRECT_URI",
      required.VITE_COGNITO_REDIRECT_URI,
    );
    if (endpoint.protocol !== "https:")
      throw new Error(`${apiKey} must be the HTTPS API Gateway invoke URL.`);
    if (domain.protocol !== "https:" || domain.pathname !== "/") {
      throw new Error(
        "VITE_COGNITO_DOMAIN must be the HTTPS Cognito sign-in origin without a path.",
      );
    }
    if (
      redirect.origin !== page.origin ||
      redirect.pathname !== page.pathname
    ) {
      throw new Error(
        "VITE_COGNITO_REDIRECT_URI must match the origin and path open in this browser and the callback URL registered in Cognito. Use the configured hostname and port.",
      );
    }
    if (/\s/.test(required.VITE_COGNITO_SCOPE)) {
      throw new Error(
        "VITE_COGNITO_SCOPE must contain one access-token scope, such as cloudvault/workspace.",
      );
    }
    return {
      mode,
      settings: {
        endpoint: endpoint.href.replace(/\/+$/, ""),
        domain: domain.origin,
        clientId: required.VITE_COGNITO_CLIENT_ID,
        scope: required.VITE_COGNITO_SCOPE,
        redirect: redirect.href,
      },
    };
  } catch (error) {
    return {
      mode: "error",
      title: "AWS workspace configuration error",
      message: (error as Error).message,
    };
  }
}
