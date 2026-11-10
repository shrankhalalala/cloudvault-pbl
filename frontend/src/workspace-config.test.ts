import { describe, expect, it } from "vitest";
import { resolveWorkspaceConfig } from "./workspace-config";

const page = { origin: "http://localhost:5173", pathname: "/" };
const awsEnv = {
  VITE_CLOUDVAULT_MODE: "aws",
  VITE_CLOUDVAULT_API_BASE_URL: "https://api.example.invalid/stage/",
  VITE_COGNITO_DOMAIN: "https://login.example.invalid/",
  VITE_COGNITO_CLIENT_ID: "public-client-id",
  VITE_COGNITO_SCOPE: "cloudvault/workspace",
  VITE_COGNITO_REDIRECT_URI: "http://localhost:5173/",
};

describe("workspace startup configuration", () => {
  it("uses the configured AWS endpoint and Cognito settings ahead of stale legacy settings", () => {
    expect(
      resolveWorkspaceConfig(
        {
          ...awsEnv,
          VITE_API_MODE: "demo",
          VITE_API_BASE_URL: "https://old.example.invalid",
        },
        page,
      ),
    ).toEqual({
      mode: "aws",
      settings: {
        endpoint: "https://api.example.invalid/stage",
        domain: "https://login.example.invalid",
        clientId: "public-client-id",
        scope: "cloudvault/workspace",
        redirect: "http://localhost:5173/",
      },
    });
  });

  it("supports explicit demo and the previous cloud variable names", () => {
    expect(
      resolveWorkspaceConfig({ VITE_CLOUDVAULT_MODE: "demo" }, page),
    ).toEqual({ mode: "demo" });
    expect(resolveWorkspaceConfig({ VITE_API_MODE: "demo" }, page)).toEqual({
      mode: "demo",
    });
    expect(
      resolveWorkspaceConfig(
        {
          ...awsEnv,
          VITE_CLOUDVAULT_MODE: undefined,
          VITE_CLOUDVAULT_API_BASE_URL: undefined,
          VITE_API_MODE: "cloud",
          VITE_API_BASE_URL: awsEnv.VITE_CLOUDVAULT_API_BASE_URL,
        },
        page,
      ),
    ).toMatchObject({ mode: "aws" });
  });

  it("names missing AWS settings even if legacy demo is set", () => {
    expect(
      resolveWorkspaceConfig(
        { VITE_CLOUDVAULT_MODE: "aws", VITE_API_MODE: "demo" },
        page,
      ),
    ).toMatchObject({
      mode: "error",
      title: "AWS workspace configuration error",
      message: expect.stringContaining("VITE_CLOUDVAULT_API_BASE_URL"),
    });
  });

  it("requires explicit mode selection and rejects an invalid primary mode", () => {
    expect(resolveWorkspaceConfig({}, page)).toMatchObject({ mode: "error" });
    expect(
      resolveWorkspaceConfig(
        { VITE_CLOUDVAULT_MODE: "invalid", VITE_API_MODE: "demo" },
        page,
      ),
    ).toMatchObject({ mode: "error" });
  });

  it("rejects an invalid endpoint and an origin mismatch without revealing configuration values", () => {
    expect(
      resolveWorkspaceConfig(
        { ...awsEnv, VITE_CLOUDVAULT_API_BASE_URL: "http://example.invalid" },
        page,
      ),
    ).toMatchObject({
      mode: "error",
      message: expect.stringContaining("HTTPS"),
    });
    const result = resolveWorkspaceConfig(awsEnv, {
      ...page,
      origin: "http://127.0.0.1:5173",
    });
    expect(result).toMatchObject({
      mode: "error",
      message: expect.stringContaining("VITE_COGNITO_REDIRECT_URI"),
    });
  });
});
