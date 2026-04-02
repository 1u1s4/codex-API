import fs from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loginOpenAICodex, refreshOpenAICodexToken } from "@mariozechner/pi-ai/oauth";
import { isFiniteNumber, normalizeNonEmptyString } from "./shared.js";
import type { CodexCredential } from "./types.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_AUTH_FILE = path.join(PACKAGE_ROOT, "codex-auth.json");

export type AuthCallbacks = {
  onAuth?: (params: { url: string; instructions?: string }) => Promise<void> | void;
  onPrompt?: (params: {
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
  }) => Promise<string> | string;
  onManualCodeInput?: () => Promise<string> | string;
  onProgress?: (message: string) => Promise<void> | void;
};

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

async function ensureAuthDir(authFile: string): Promise<void> {
  await fs.mkdir(path.dirname(authFile), { recursive: true });
}

async function ask(prompt: string, options: { placeholder?: string; allowEmpty?: boolean } = {}) {
  const rl = createInterface({ input, output });
  const suffix = normalizeNonEmptyString(options.placeholder);
  const message = suffix ? `${prompt} (${suffix}): ` : `${prompt}: `;

  try {
    const answer = await rl.question(message);
    return options.allowEmpty ? answer : answer.trim();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ABORT_ERR") {
      const aborted = new Error("Prompt aborted.");
      Object.assign(aborted, { code: "ABORT_ERR" });
      throw aborted;
    }
    throw error;
  } finally {
    rl.close();
  }
}

function createDefaultCallbacks(): Required<AuthCallbacks> {
  return {
    onAuth: ({ url, instructions }) => {
      console.log("");
      console.log("Open this URL in your browser:");
      console.log(url);
      const note = normalizeNonEmptyString(instructions);
      if (note) {
        console.log("");
        console.log(note);
      }
      console.log("");
    },
    onPrompt: ({ message, placeholder, allowEmpty }) =>
      ask(message, { placeholder, allowEmpty }),
    onManualCodeInput: () =>
      ask("Paste the authorization code or the full redirect URL", {
        placeholder: "code or redirect URL",
      }),
    onProgress: (message) => {
      const normalized = normalizeNonEmptyString(message);
      if (normalized) {
        console.log(normalized);
      }
    },
  };
}

export function createCodexAuth(options: CreateCodexAuthOptions = {}) {
  const authFile = options.authFile ?? process.env.CODEX_AUTH_FILE ?? DEFAULT_AUTH_FILE;
  const loginFn = options.loginFn ?? loginOpenAICodex;
  const refreshFn = options.refreshFn ?? refreshOpenAICodexToken;
  const baseCallbacks = {
    ...createDefaultCallbacks(),
    ...(options.onAuth ? { onAuth: options.onAuth } : {}),
    ...(options.onPrompt ? { onPrompt: options.onPrompt } : {}),
    ...(options.onManualCodeInput ? { onManualCodeInput: options.onManualCodeInput } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };
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
    await ensureAuthDir(authFile);
    await fs.writeFile(authFile, `${JSON.stringify(credential, null, 2)}\n`, "utf8");
  }

  async function loadCredential(): Promise<CodexCredential | null> {
    try {
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
