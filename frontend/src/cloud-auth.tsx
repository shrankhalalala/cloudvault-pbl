import { useEffect, useMemo, useState } from "react";
import App from "./App";
import { CloudApi } from "./cloud-api";
import { Vault } from "./components";
import type { AwsSettings } from "./workspace-config";

const TRANSACTION = "cloudvault-pkce";
type Session = { token: string; expiresAt: number };
type Transaction = { state: string; verifier: string; createdAt: number };

function urlSafe(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function signIn(config: AwsSettings) {
  const verifier = urlSafe(crypto.getRandomValues(new Uint8Array(32)));
  const state = urlSafe(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = urlSafe(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const transaction: Transaction = { verifier, state, createdAt: Date.now() };
  sessionStorage.setItem(TRANSACTION, JSON.stringify(transaction));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirect,
    scope: config.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  location.assign(`${config.domain}/oauth2/authorize?${params}`);
}

let callback: Promise<Session | null> | undefined;
function completeSignIn(config: AwsSettings) {
  return (callback ??= exchangeCallback(config));
}

async function exchangeCallback(config: AwsSettings): Promise<Session | null> {
  const query = new URLSearchParams(location.search);
  if (!query.has("code") && !query.has("error")) return null;
  const saved = sessionStorage.getItem(TRANSACTION);
  sessionStorage.removeItem(TRANSACTION);
  history.replaceState(null, "", config.redirect + location.hash);
  const transaction: Transaction | null = saved ? JSON.parse(saved) : null;
  const code = query.get("code");
  if (
    !transaction ||
    query.get("state") !== transaction.state ||
    Date.now() - transaction.createdAt > 600_000 ||
    !code ||
    query.has("error")
  ) {
    throw new Error("Sign-in could not be verified. Start a new sign-in.");
  }
  const response = await fetch(config.domain + "/oauth2/token", {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: config.redirect,
      code_verifier: transaction.verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error("Cognito could not complete sign-in. Try again.");
  const payload = await response.json();
  if (
    typeof payload.access_token !== "string" ||
    !payload.access_token ||
    typeof payload.expires_in !== "number" ||
    !Number.isFinite(payload.expires_in) ||
    payload.expires_in <= 0
  )
    throw new Error("Cognito returned an invalid session.");
  return {
    token: payload.access_token,
    expiresAt: Date.now() + Math.min(payload.expires_in, 3600) * 1000,
  };
}

export function CloudGate({ config }: { config: AwsSettings }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    void completeSignIn(config)
      .then((result) => {
        if (mounted) setSession(result);
      })
      .catch(() => {
        if (mounted)
          setError("Sign-in could not be completed. Start a new sign-in.");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [config]);

  function expire() {
    callback = undefined;
    setSession(null);
    setError("Your session expired. Sign in again to continue.");
  }
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      expire,
      Math.max(0, session.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [session]);
  const api = useMemo(
    () =>
      session ? new CloudApi(config.endpoint, session.token, expire) : null,
    [config, session],
  );

  if (api) {
    return (
      <App
        cloud={api}
        onSignOut={() => {
          callback = undefined;
          setSession(null);
          const query = new URLSearchParams({
            client_id: config.clientId,
            logout_uri: config.redirect,
          });
          location.assign(`${config.domain}/logout?${query}`);
        }}
      />
    );
  }
  return (
    <main className="share-screen">
      <div className="brand">
        <Vault />
        CloudVault
      </div>
      <span className="demo-tag">AWS workspace</span>
      <h1>Sign in to CloudVault</h1>
      <p>Use the Cognito account assigned to this workspace.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button
        className="primary"
        disabled={loading}
        onClick={() => {
          setError("");
          setLoading(true);
          void signIn(config).catch(() => {
            setLoading(false);
            setError(
              "Could not start sign-in. Allow browser session storage and try again.",
            );
          });
        }}
      >
        {loading ? "Checking session…" : "Sign in with Cognito"}
      </button>
    </main>
  );
}
