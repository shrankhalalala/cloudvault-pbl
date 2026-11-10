import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import App from "./App";
import { CloudGate } from "./cloud-auth";
import { resolveWorkspaceConfig } from "./workspace-config";
import "./styles.css";
const config = resolveWorkspaceConfig(
  {
    VITE_CLOUDVAULT_MODE: import.meta.env.VITE_CLOUDVAULT_MODE,
    VITE_CLOUDVAULT_API_BASE_URL: import.meta.env.VITE_CLOUDVAULT_API_BASE_URL,
    VITE_API_MODE: import.meta.env.VITE_API_MODE,
    VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
    VITE_COGNITO_DOMAIN: import.meta.env.VITE_COGNITO_DOMAIN,
    VITE_COGNITO_CLIENT_ID: import.meta.env.VITE_COGNITO_CLIENT_ID,
    VITE_COGNITO_SCOPE: import.meta.env.VITE_COGNITO_SCOPE,
    VITE_COGNITO_REDIRECT_URI: import.meta.env.VITE_COGNITO_REDIRECT_URI,
  },
  window.location,
);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {config.mode === "demo" ? (
      <App />
    ) : config.mode === "aws" ? (
      <CloudGate config={config.settings} />
    ) : (
      <main className="config-error">
        <h1>{config.title}</h1>
        <p role="alert">{config.message}</p>
        <p>After editing frontend/.env.local, restart Vite.</p>
      </main>
    )}
  </React.StrictMode>,
);
