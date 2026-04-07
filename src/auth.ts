import path from "node:path";
import { loginOpenAICodex, refreshOpenAICodexToken } from "@mariozechner/pi-ai/oauth";
import {
  createDefaultInteractiveAuthCallbacks,
  type InteractiveAuthCallbacks,
} from "./interactive-auth.js";
import { writeJsonFileAtomic } from "./json-file.js";
import { isFiniteNumber, normalizeNonEmptyString } from "./shared.js";
import type { CodexCredential } from "./types.js";

const DEFAULT_AUTH_FILENAME = "codex-auth.json";
export const DEFAULT_AUTH_FILE = path.resolve(DEFAULT_AUTH_FILENAME);

export type AuthCallbacks = InteractiveAuthCallbacks;

export type CreateCodexAuthOptions = AuthCallbacks & {
  authFile?: string;
  loginFn?: typeof loginOpenAICodex;
  refreshFn?: typeof refreshOpenAICodexToken;
};

export type CodexAuth = ReturnType<typeof createCodexAuth>;

export function decodeJwtPayload(accessToken: string | undefined): Record<string, unknown> | null {
  const token = normalizeNonEmptyString(accessToken);
  if (!token) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const payloadSegment = parts[1];
    if (!payloadSegment) {
      return null;
    }
    const decoded = Buffer.from(payloadSegment, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function resolveAccountId(accessToken: string | undefined): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return (
    normalizeNonEmptyString(auth?.chatgpt_account_user_id) ??
    normalizeNonEmptyString(auth?.chatgpt_user_id) ??
    normalizeNonEmptyString(auth?.user_id)
  );
}

export function resolveEmail(
  accessToken: string | undefined,
  fallback?: string,
): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const profile = payload?.["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
  return normalizeNonEmptyString(profile?.email) ?? normalizeNonEmptyString(fallback);
}

function enrichCredential(
  credential: Partial<CodexCredential> | null | undefined,
  fallbackCredential?: Partial<CodexCredential> | null,
): CodexCredential {
  const access = normalizeNonEmptyString(credential?.access ?? fallbackCredential?.access);
  if (!access) {
    throw new Error("Codex credential did not include an access token.");
  }

  const expires = credential?.expires ?? fallbackCredential?.expires;
  if (!isFiniteNumber(expires)) {
    throw new Error("Codex credential did not include a valid expires timestamp.");
  }

  const refresh =
    normalizeNonEmptyString(credential?.refresh) ??
    normalizeNonEmptyString(fallbackCredential?.refresh);
  const email = resolveEmail(access, credential?.email ?? fallbackCredential?.email);
  const accountId = resolveAccountId(access) ?? fallbackCredential?.accountId;

  return {
    ...(fallbackCredential ?? {}),
    ...(credential ?? {}),
    access,
    expires,
    ...(refresh ? { refresh } : {}),
    ...(email ? { email } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

function hasExpired(credential: Partial<CodexCredential> | null | undefined): boolean {
  return !isFiniteNumber(credential?.expires) || Date.now() >= credential.expires;
}

export function createCodexAuth(options: CreateCodexAuthOptions = {}) {
  const authFile =
    options.authFile ??
    process.env.CODEX_AUTH_FILE ??
    path.resolve(DEFAULT_AUTH_FILENAME);
  const loginFn = options.loginFn ?? loginOpenAICodex;
  const refreshFn = options.refreshFn ?? refreshOpenAICodexToken;
  const baseCallbacks = createDefaultInteractiveAuthCallbacks(options, {
    authTitle: "Codex authentication",
    defaultManualPrompt: "Paste the authorization code or the full redirect URL",
  });
  const callbacks: Parameters<typeof loginOpenAICodex>[0] = {
    onAuth: (params) => {
      void baseCallbacks.onAuth(params);
    },
    onPrompt: async (params) => await baseCallbacks.onPrompt(params),
    onManualCodeInput: async () => await baseCallbacks.onManualCodeInput(),
    onProgress: (message) => {
      void baseCallbacks.onProgress(message);
    },
  };

  async function saveCredential(credential: CodexCredential): Promise<void> {
    await writeJsonFileAtomic(authFile, credential);
  }

  async function loadCredential(): Promise<CodexCredential | null> {
    try {
      const fs = await import("node:fs/promises");
      const content = await fs.readFile(authFile, "utf8");
      const parsed = JSON.parse(content);
      return parsed && typeof parsed === "object" ? enrichCredential(parsed as CodexCredential) : null;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async function login(): Promise<CodexCredential> {
    const credential = await loginFn(callbacks);
    const enriched = enrichCredential(credential as Partial<CodexCredential>);
    await saveCredential(enriched);
    return enriched;
  }

  async function getFreshCredential(): Promise<CodexCredential> {
    const current = await loadCredential();
    if (!current) {
      return login();
    }

    if (!hasExpired(current)) {
      return current;
    }

    const refresh = normalizeNonEmptyString(current.refresh);
    if (!refresh) {
      return login();
    }

    const refreshed = await refreshFn(refresh);
    const enriched = enrichCredential(refreshed as Partial<CodexCredential>, current);
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
