import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { delimiter, dirname, join } from "node:path";
import path from "node:path";
import type { FetchLike, GeminiCredential } from "./types.js";
import {
  createDefaultInteractiveAuthCallbacks,
  type InteractiveAuthCallbacks,
} from "./interactive-auth.js";
import { writeJsonFileAtomic } from "./json-file.js";
import { isFiniteNumber, normalizeNonEmptyString } from "./shared.js";

const DEFAULT_AUTH_FILENAME = "gemini-auth.json";
export const DEFAULT_GEMINI_AUTH_FILE = path.resolve(DEFAULT_AUTH_FILENAME);

const GOOGLE_OAUTH_CLIENT_ID_KEYS = [
  "GEMINI_CLI_OAUTH_CLIENT_ID",
  "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
] as const;
const GOOGLE_OAUTH_CLIENT_SECRET_KEYS = [
  "GEMINI_CLI_OAUTH_CLIENT_SECRET",
  "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
] as const;

const GEMINI_REDIRECT_URI = "http://localhost:8085/oauth2callback";
const GEMINI_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GEMINI_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GEMINI_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const GEMINI_LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";

const GEMINI_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

type GeminiAuthFs = {
  existsSync: (path: Parameters<typeof existsSync>[0]) => boolean;
  readFileSync: (path: Parameters<typeof readFileSync>[0], encoding: "utf8") => string;
  realpathSync: (path: Parameters<typeof realpathSync>[0]) => string;
  readdirSync: (
    path: Parameters<typeof readdirSync>[0],
    options: { withFileTypes: true },
  ) => Dirent[];
};

const defaultGeminiAuthFs: GeminiAuthFs = {
  existsSync,
  readFileSync,
  realpathSync,
  readdirSync,
};

let geminiAuthFs: GeminiAuthFs = defaultGeminiAuthFs;

type GeminiOAuthClientConfig = {
  clientId: string;
  clientSecret?: string;
};

type GeminiCallbackResult = {
  code: string;
  state: string;
};

type GeminiCallbackServer = {
  waitForCode: () => Promise<GeminiCallbackResult>;
  close: () => Promise<void>;
};

export type GeminiAuthCallbacks = InteractiveAuthCallbacks;

export type CreateGeminiAuthOptions = GeminiAuthCallbacks & {
  authFile?: string;
  fetchFn?: FetchLike;
  resolveOAuthClientConfigFn?: () => GeminiOAuthClientConfig;
  startCallbackServerFn?: (timeoutMs: number) => Promise<GeminiCallbackServer>;
  callbackTimeoutMs?: number;
  loginFn?: (callbacks: Required<GeminiAuthCallbacks>) => Promise<GeminiCredential>;
  refreshFn?: (credential: GeminiCredential) => Promise<GeminiCredential>;
};

export type GeminiAuth = ReturnType<typeof createGeminiAuth>;

export function setGeminiAuthFsForTest(overrides?: Partial<GeminiAuthFs>): void {
  geminiAuthFs = overrides ? { ...defaultGeminiAuthFs, ...overrides } : defaultGeminiAuthFs;
}

function normalizeEnv(keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = normalizeNonEmptyString(process.env[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function findInPath(name: string): string | null {
  const extensions = process.platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (geminiAuthFs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function findFile(dir: string, fileName: string, depth: number): string | null {
  if (depth <= 0) {
    return null;
  }
  try {
    for (const entry of geminiAuthFs.readdirSync(dir, { withFileTypes: true })) {
      const candidate = join(dir, entry.name);
      if (entry.isFile() && entry.name === fileName) {
        return candidate;
      }
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const found = findFile(candidate, fileName, depth - 1);
        if (found) {
          return found;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function resolveGeminiCliDirs(geminiPath: string, resolvedPath: string): string[] {
  const binDir = dirname(geminiPath);
  const candidates = [
    dirname(dirname(resolvedPath)),
    join(dirname(resolvedPath), "node_modules", "@google", "gemini-cli"),
    join(binDir, "node_modules", "@google", "gemini-cli"),
    join(dirname(binDir), "node_modules", "@google", "gemini-cli"),
    join(dirname(binDir), "lib", "node_modules", "@google", "gemini-cli"),
  ];
  return [...new Set(candidates)];
}

export function extractGeminiCliOAuthCredentials(): GeminiOAuthClientConfig | null {
  try {
    const binaryPath = normalizeNonEmptyString(process.env.GEMINI_CLI_PATH) ?? findInPath("gemini");
    if (!binaryPath) {
      return null;
    }

    const resolvedPath = geminiAuthFs.realpathSync(binaryPath);
    const geminiDirs = resolveGeminiCliDirs(binaryPath, resolvedPath);

    let content: string | null = null;
    for (const geminiDir of geminiDirs) {
      const searchPaths = [
        join(
          geminiDir,
          "node_modules",
          "@google",
          "gemini-cli-core",
          "dist",
          "src",
          "code_assist",
          "oauth2.js",
        ),
        join(
          geminiDir,
          "node_modules",
          "@google",
          "gemini-cli-core",
          "dist",
          "code_assist",
          "oauth2.js",
        ),
      ];

      for (const searchPath of searchPaths) {
        if (geminiAuthFs.existsSync(searchPath)) {
          content = geminiAuthFs.readFileSync(searchPath, "utf8");
          break;
        }
      }

      if (content) {
        break;
      }

      const found = findFile(geminiDir, "oauth2.js", 10);
      if (found) {
        content = geminiAuthFs.readFileSync(found, "utf8");
        break;
      }
    }

    if (!content) {
      return null;
    }

    const idMatch = content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/i);
    const secretMatch = content.match(/(GOCSPX-[A-Za-z0-9_-]+)/);
    if (!idMatch?.[1]) {
      return null;
    }

    return {
      clientId: idMatch[1],
      clientSecret: secretMatch?.[1],
    };
  } catch {
    return null;
  }
}

export function resolveGeminiOAuthClientConfig(): GeminiOAuthClientConfig {
  const envClientId = normalizeEnv(GOOGLE_OAUTH_CLIENT_ID_KEYS);
  if (envClientId) {
    return {
      clientId: envClientId,
      clientSecret: normalizeEnv(GOOGLE_OAUTH_CLIENT_SECRET_KEYS),
    };
  }

  const extracted = extractGeminiCliOAuthCredentials();
  if (extracted?.clientId) {
    return extracted;
  }

  throw new Error(
    "Gemini OAuth client not configured. Set GEMINI_CLI_OAUTH_CLIENT_ID or install the Gemini CLI locally.",
  );
}

export function parseGeminiCallbackInput(
  input: string,
  expectedState: string,
): GeminiCallbackResult | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: "No input provided." };
  }

  try {
    const url = new URL(trimmed);
    const code = normalizeNonEmptyString(url.searchParams.get("code"));
    const state = normalizeNonEmptyString(url.searchParams.get("state")) ?? expectedState;
    if (!code) {
      return { error: "Missing code parameter in redirect URL." };
    }
    if (!state) {
      return { error: "Missing state parameter in redirect URL." };
    }
    return { code, state };
  } catch {
    if (!expectedState) {
      return { error: "Paste the full redirect URL instead of only the code." };
    }
    return { code: trimmed, state: expectedState };
  }
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildGeminiAuthUrl(config: GeminiOAuthClientConfig, verifier: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: GEMINI_REDIRECT_URI,
    scope: GEMINI_SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
    access_type: "offline",
    prompt: "consent",
  });
  return `${GEMINI_AUTH_URL}?${params.toString()}`;
}

export async function startGeminiCallbackServer(timeoutMs: number): Promise<GeminiCallbackServer> {
  return await createResolvableGeminiCallbackServer(timeoutMs);
}

async function createResolvableGeminiCallbackServer(timeoutMs: number): Promise<GeminiCallbackServer> {
  const port = 8085;
  const host = "127.0.0.1";

  return await new Promise<GeminiCallbackServer>((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;
    let settle:
      | ((value: GeminiCallbackResult | PromiseLike<GeminiCallbackResult>) => void)
      | undefined;
    let rejectWait: ((reason?: unknown) => void) | undefined;

    const waitForCode = new Promise<GeminiCallbackResult>((resolveWait, rejectWaitInternal) => {
      settle = resolveWait;
      rejectWait = rejectWaitInternal;
    });

    const server = createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url ?? "/", `http://${host}:${port}`);
        if (requestUrl.pathname !== "/oauth2callback") {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }

        const code = normalizeNonEmptyString(requestUrl.searchParams.get("code"));
        const state = normalizeNonEmptyString(requestUrl.searchParams.get("state"));
        const error = normalizeNonEmptyString(requestUrl.searchParams.get("error"));

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<!doctype html><html><body><h2>Gemini OAuth failed</h2></body></html>");
          rejectWait?.(new Error(`Gemini OAuth error: ${error}`));
          return;
        }

        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Missing code or state");
          rejectWait?.(new Error("Gemini OAuth callback did not include code and state."));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><html><body><h2>Gemini OAuth complete</h2><p>You can close this window.</p></body></html>",
        );
        settle?.({ code, state });
      } catch (error) {
        rejectWait?.(error);
      }
    });

    server.once("error", (error) => {
      reject(error);
    });

    server.listen(port, host, () => {
      timeout = setTimeout(() => {
        rejectWait?.(new Error("Timed out waiting for the Gemini OAuth callback."));
      }, timeoutMs);

      resolve({
        waitForCode: async () => await waitForCode,
        close: async () => {
          if (timeout) {
            clearTimeout(timeout);
          }
          await new Promise<void>((resolveClose) => {
            try {
              server.close(() => resolveClose());
            } catch {
              resolveClose();
            }
          });
        },
      });
    });
  });
}

async function fetchGeminiUserEmail(accessToken: string, fetchFn: FetchLike): Promise<string | undefined> {
  try {
    const response = await fetchFn(GEMINI_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as { email?: unknown };
    return normalizeNonEmptyString(payload.email);
  } catch {
    return undefined;
  }
}

async function fetchGeminiProjectId(accessToken: string, fetchFn: FetchLike): Promise<string | undefined> {
  const envProjectId =
    normalizeNonEmptyString(process.env.GOOGLE_CLOUD_PROJECT) ??
    normalizeNonEmptyString(process.env.GOOGLE_CLOUD_PROJECT_ID);
  if (envProjectId) {
    return envProjectId;
  }

  try {
    const response = await fetchFn(GEMINI_LOAD_CODE_ASSIST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "codex-openai-api",
      },
      body: JSON.stringify({
        metadata: {
          pluginType: "GEMINI",
        },
      }),
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as {
      cloudaicompanionProject?: { id?: unknown } | unknown;
    };
    const projectPayload = payload.cloudaicompanionProject;
    if (projectPayload && typeof projectPayload === "object" && "id" in projectPayload) {
      return normalizeNonEmptyString((projectPayload as { id?: unknown }).id);
    }
    return normalizeNonEmptyString(projectPayload);
  } catch {
    return undefined;
  }
}

async function exchangeGeminiCodeForTokens(params: {
  code: string;
  verifier: string;
  config: GeminiOAuthClientConfig;
  fetchFn: FetchLike;
}): Promise<GeminiCredential> {
  const body = new URLSearchParams({
    client_id: params.config.clientId,
    code: params.code,
    grant_type: "authorization_code",
    redirect_uri: GEMINI_REDIRECT_URI,
    code_verifier: params.verifier,
  });
  if (params.config.clientSecret) {
    body.set("client_secret", params.config.clientSecret);
  }

  const response = await params.fetchFn(GEMINI_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "*/*",
      "User-Agent": "codex-openai-api",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`Gemini token exchange failed: ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  const access = normalizeNonEmptyString(payload.access_token);
  const refresh = normalizeNonEmptyString(payload.refresh_token);
  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : undefined;

  if (!access || !refresh || !expiresIn) {
    throw new Error("Gemini token exchange returned an incomplete credential payload.");
  }

  const [email, projectId] = await Promise.all([
    fetchGeminiUserEmail(access, params.fetchFn),
    fetchGeminiProjectId(access, params.fetchFn),
  ]);

  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
    ...(email ? { email } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

async function refreshGeminiOAuthCredential(
  credential: GeminiCredential,
  fetchFn: FetchLike,
  resolveConfig: () => GeminiOAuthClientConfig,
): Promise<GeminiCredential> {
  const refreshToken = normalizeNonEmptyString(credential.refresh);
  if (!refreshToken) {
    throw new Error("Gemini credential does not include a refresh token.");
  }

  const config = resolveConfig();
  const body = new URLSearchParams({
    client_id: config.clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (config.clientSecret) {
    body.set("client_secret", config.clientSecret);
  }

  const response = await fetchFn(GEMINI_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "*/*",
      "User-Agent": "codex-openai-api",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`Gemini token refresh failed: ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };

  const access = normalizeNonEmptyString(payload.access_token);
  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : undefined;
  if (!access || !expiresIn) {
    throw new Error("Gemini token refresh returned an incomplete credential payload.");
  }

  const email = credential.email ?? (await fetchGeminiUserEmail(access, fetchFn));

  return {
    ...credential,
    access,
    refresh: normalizeNonEmptyString(payload.refresh_token) ?? refreshToken,
    expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
    ...(email ? { email } : {}),
  };
}

function hasExpired(credential: Partial<GeminiCredential> | null | undefined): boolean {
  return !isFiniteNumber(credential?.expires) || Date.now() >= credential.expires;
}

function enrichGeminiCredential(
  credential: Partial<GeminiCredential> | null | undefined,
  fallbackCredential?: Partial<GeminiCredential> | null,
): GeminiCredential {
  const access = normalizeNonEmptyString(credential?.access ?? fallbackCredential?.access);
  if (!access) {
    throw new Error("Gemini credential did not include an access token.");
  }

  const expires = credential?.expires ?? fallbackCredential?.expires;
  if (!isFiniteNumber(expires)) {
    throw new Error("Gemini credential did not include a valid expires timestamp.");
  }

  const refresh =
    normalizeNonEmptyString(credential?.refresh) ??
    normalizeNonEmptyString(fallbackCredential?.refresh);

  return {
    ...(fallbackCredential ?? {}),
    ...(credential ?? {}),
    access,
    expires,
    ...(refresh ? { refresh } : {}),
    ...(normalizeNonEmptyString(credential?.email ?? fallbackCredential?.email)
      ? { email: normalizeNonEmptyString(credential?.email ?? fallbackCredential?.email) }
      : {}),
    ...(normalizeNonEmptyString(credential?.projectId ?? fallbackCredential?.projectId)
      ? { projectId: normalizeNonEmptyString(credential?.projectId ?? fallbackCredential?.projectId) }
      : {}),
  };
}

async function runGeminiLoginFlow(params: {
  callbacks: Required<GeminiAuthCallbacks>;
  fetchFn: FetchLike;
  resolveConfig: () => GeminiOAuthClientConfig;
  startCallbackServer: (timeoutMs: number) => Promise<GeminiCallbackServer>;
  timeoutMs: number;
}): Promise<GeminiCredential> {
  const config = params.resolveConfig();
  const { verifier, challenge } = generatePkce();
  const authUrl = buildGeminiAuthUrl(config, verifier, challenge);

  await params.callbacks.onAuth({
    url: authUrl,
    instructions:
      "Sign in with your Google account. If localhost callback capture fails, paste the redirect URL here when prompted.",
  });

  let code: string | undefined;
  let callbackServer: GeminiCallbackServer | null = null;
  try {
    callbackServer = await params.startCallbackServer(params.timeoutMs);
  } catch (error) {
    await params.callbacks.onProgress(
      `Gemini OAuth callback server unavailable, falling back to manual code entry: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const readManualCode = async (): Promise<string> => {
    const manualInput = await params.callbacks.onManualCodeInput();
    const parsed = parseGeminiCallbackInput(manualInput, verifier);
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    if (parsed.state !== verifier) {
      throw new Error("Gemini OAuth state mismatch.");
    }
    return parsed.code;
  };

  if (!callbackServer) {
    code = await readManualCode();
  } else {
    try {
      await params.callbacks.onProgress("Waiting for Gemini OAuth callback...");
      try {
        const callback = await callbackServer.waitForCode();
        if (callback.state !== verifier) {
          throw new Error("Gemini OAuth state mismatch.");
        }
        code = callback.code;
      } catch {
        code = await readManualCode();
      }
    } finally {
      await callbackServer.close();
    }
  }

  await params.callbacks.onProgress("Exchanging Gemini authorization code...");
  return await exchangeGeminiCodeForTokens({
    code,
    verifier,
    config,
    fetchFn: params.fetchFn,
  });
}

export function createGeminiAuth(options: CreateGeminiAuthOptions = {}) {
  const authFile =
    options.authFile ??
    process.env.GEMINI_AUTH_FILE ??
    path.resolve(DEFAULT_AUTH_FILENAME);
  const fetchFn = options.fetchFn ?? fetch;
  const resolveConfig = options.resolveOAuthClientConfigFn ?? resolveGeminiOAuthClientConfig;
  const startCallbackServer =
    options.startCallbackServerFn ?? createResolvableGeminiCallbackServer;
  const timeoutMs = options.callbackTimeoutMs ?? 5 * 60 * 1000;

  const baseCallbacks = createDefaultInteractiveAuthCallbacks(options, {
    authTitle: "Gemini authentication",
    defaultManualPrompt: "Paste the authorization code or the full redirect URL",
  });

  async function saveCredential(credential: GeminiCredential): Promise<void> {
    await writeJsonFileAtomic(authFile, credential);
  }

  async function loadCredential(): Promise<GeminiCredential | null> {
    try {
      const content = await fs.readFile(authFile, "utf8");
      const parsed = JSON.parse(content);
      return parsed && typeof parsed === "object"
        ? enrichGeminiCredential(parsed as GeminiCredential)
        : null;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async function login(): Promise<GeminiCredential> {
    const loginFn =
      options.loginFn ??
      (async (callbacks: Required<GeminiAuthCallbacks>) =>
        await runGeminiLoginFlow({
          callbacks,
          fetchFn,
          resolveConfig,
          startCallbackServer,
          timeoutMs,
        }));
    const credential = await loginFn(baseCallbacks);
    const enriched = enrichGeminiCredential(credential);
    await saveCredential(enriched);
    return enriched;
  }

  async function getFreshCredential(): Promise<GeminiCredential> {
    const current = await loadCredential();
    if (!current) {
      return await login();
    }

    if (!hasExpired(current)) {
      return current;
    }

    if (!normalizeNonEmptyString(current.refresh)) {
      return await login();
    }

    const refreshFn =
      options.refreshFn ??
      (async (credential: GeminiCredential) =>
        await refreshGeminiOAuthCredential(credential, fetchFn, resolveConfig));
    const refreshed = await refreshFn(current);
    const enriched = enrichGeminiCredential(refreshed, current);
    await saveCredential(enriched);
    return enriched;
  }

  return {
    authFile,
    loadCredential,
    saveCredential,
    login,
    getFreshCredential,
  };
}
