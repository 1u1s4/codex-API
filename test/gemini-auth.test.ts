import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGeminiAuth,
  resolveGeminiOAuthClientConfig,
  setGeminiAuthFsForTest,
} from "../src/gemini-auth.js";
import type { GeminiCredential } from "../src/types.js";

const TRACKED_ENV_KEYS = [
  "GEMINI_AUTH_FILE",
  "GEMINI_CLI_PATH",
  "GEMINI_CLI_OAUTH_CLIENT_ID",
  "GEMINI_CLI_OAUTH_CLIENT_SECRET",
  "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
  "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
] as const;

const envSnapshot = new Map<string, string | undefined>(
  TRACKED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function restoreTrackedEnv(): void {
  for (const key of TRACKED_ENV_KEYS) {
    const value = envSnapshot.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

async function createTempAuthFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gemini-auth-test-"));
  return path.join(dir, "gemini-auth.json");
}

afterEach(() => {
  restoreTrackedEnv();
  setGeminiAuthFsForTest();
  vi.restoreAllMocks();
});

describe("createGeminiAuth", () => {
  it("saves, loads, and refreshes Gemini credentials", async () => {
    const authFile = await createTempAuthFile();
    const refreshFn = vi.fn(async (_credential: GeminiCredential) => ({
      access: "access_fresh",
      refresh: "refresh_fresh",
      expires: Date.now() + 300_000,
      email: "fresh@example.com",
      projectId: "proj_fresh",
    }));
    const auth = createGeminiAuth({
      authFile,
      refreshFn,
    });

    await auth.saveCredential({
      access: "access_old",
      refresh: "refresh_old",
      expires: Date.now() - 1_000,
      email: "old@example.com",
      projectId: "proj_old",
    });

    await expect(auth.loadCredential()).resolves.toMatchObject({
      access: "access_old",
      refresh: "refresh_old",
      email: "old@example.com",
      projectId: "proj_old",
    });

    const refreshed = await auth.getFreshCredential();
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(refreshed).toMatchObject({
      access: "access_fresh",
      refresh: "refresh_fresh",
      email: "fresh@example.com",
      projectId: "proj_fresh",
    });
    await expect(auth.loadCredential()).resolves.toMatchObject({
      access: "access_fresh",
      refresh: "refresh_fresh",
      email: "fresh@example.com",
      projectId: "proj_fresh",
    });
  });

  it("falls back to manual redirect parsing and enriches email and project id during login", async () => {
    const authFile = await createTempAuthFile();
    let authUrl = "";

    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "https://oauth2.googleapis.com/token") {
        const body = String(init?.body ?? "");
        expect(body).toContain("client_id=client-id");
        expect(body).toContain("client_secret=client-secret");
        expect(body).toContain("code=manual-code");
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("code_verifier=");
        return jsonResponse({
          access_token: "access_token",
          refresh_token: "refresh_token",
          expires_in: 3600,
        });
      }

      if (url === "https://www.googleapis.com/oauth2/v1/userinfo?alt=json") {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer access_token",
        });
        return jsonResponse({ email: "dev@example.com" });
      }

      if (url === "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") {
        expect(init?.method).toBe("POST");
        return jsonResponse({
          cloudaicompanionProject: { id: "project-123" },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const auth = createGeminiAuth({
      authFile,
      fetchFn,
      resolveOAuthClientConfigFn: () => ({
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
      startCallbackServerFn: vi.fn(async () => {
        throw new Error("EADDRINUSE");
      }),
      onAuth: async (info) => {
        authUrl = info.url;
      },
      onManualCodeInput: async () => {
        const state = new URL(authUrl).searchParams.get("state");
        return `http://localhost:8085/oauth2callback?code=manual-code&state=${state}`;
      },
      onProgress: async (message) => {
        expect(typeof message).toBe("string");
      },
    });

    const credential = await auth.login();

    expect(credential).toMatchObject({
      access: "access_token",
      refresh: "refresh_token",
      email: "dev@example.com",
      projectId: "project-123",
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    await expect(auth.loadCredential()).resolves.toMatchObject({
      email: "dev@example.com",
      projectId: "project-123",
    });
  });

  it("uses ./gemini-auth.json in the current working directory by default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gemini-auth-default-"));
    const previousCwd = process.cwd();
    const previousAuthFile = process.env.GEMINI_AUTH_FILE;

    delete process.env.GEMINI_AUTH_FILE;
    process.chdir(dir);

    try {
      const auth = createGeminiAuth();
      expect(path.basename(auth.authFile)).toBe("gemini-auth.json");
      await expect(realpath(path.dirname(auth.authFile))).resolves.toBe(await realpath(dir));

      await auth.saveCredential({
        access: "cwd_access",
        refresh: "cwd_refresh",
        expires: Date.now() + 60_000,
        email: "cwd@example.com",
        projectId: "cwd-project",
      });

      await expect(auth.loadCredential()).resolves.toMatchObject({
        email: "cwd@example.com",
        projectId: "cwd-project",
      });
    } finally {
      process.chdir(previousCwd);
      if (previousAuthFile === undefined) {
        delete process.env.GEMINI_AUTH_FILE;
      } else {
        process.env.GEMINI_AUTH_FILE = previousAuthFile;
      }
    }
  });

  it("prefers official OAuth env vars and still accepts OpenClaw compatibility aliases", () => {
    process.env.GEMINI_CLI_OAUTH_CLIENT_ID = "official-client";
    process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET = "official-secret";
    process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_ID = "alias-client";
    process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET = "alias-secret";

    expect(resolveGeminiOAuthClientConfig()).toEqual({
      clientId: "official-client",
      clientSecret: "official-secret",
    });

    delete process.env.GEMINI_CLI_OAUTH_CLIENT_ID;
    delete process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET;

    expect(resolveGeminiOAuthClientConfig()).toEqual({
      clientId: "alias-client",
      clientSecret: "alias-secret",
    });
  });

  it("can resolve OAuth client config from an installed Gemini CLI bundle", () => {
    process.env.GEMINI_CLI_PATH = "/mock/bin/gemini";
    const oauthModulePath =
      "/opt/homebrew/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js";

    setGeminiAuthFsForTest({
      existsSync: () => true,
      realpathSync: () => "/opt/homebrew/bin/gemini",
      readFileSync: () =>
        'const GOOGLE_CLIENT_ID = "123-test.apps.googleusercontent.com"; const GOOGLE_CLIENT_SECRET = "GOCSPX-test_secret";',
      readdirSync: () => [],
    });

    expect(resolveGeminiOAuthClientConfig()).toEqual({
      clientId: "123-test.apps.googleusercontent.com",
      clientSecret: "GOCSPX-test_secret",
    });
  });
});
