import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { normalizeNonEmptyString } from "./shared.js";
import type { CodexCredential, CodexModel, FetchLike, ReasoningLevel } from "./types.js";

export const DEFAULT_CODEX_CLIENT_VERSION = "0.64.0";
export const DEFAULT_CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";

const REASONING_LEVELS: ReasoningLevel[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const STATIC_CODEX_MODEL_DEFINITIONS: Array<Omit<CodexModel, "maxReasoningLevel">> = [
  {
    id: "gpt-5.2-codex",
    name: "gpt-5.2-codex",
    description: "Frontier agentic coding model.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    contextWindow: 272000,
    supportsParallelToolCalls: true,
    supportsVerbosity: false,
  },
  {
    id: "gpt-5.2",
    name: "gpt-5.2",
    description: "Optimized for professional work and long-running agents.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    contextWindow: 272000,
    supportsParallelToolCalls: true,
    supportsVerbosity: true,
  },
  {
    id: "gpt-5.1-codex-max",
    name: "gpt-5.1-codex-max",
    description: "Codex-optimized model for deep and fast reasoning.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    contextWindow: 272000,
    supportsParallelToolCalls: false,
    supportsVerbosity: false,
  },
  {
    id: "gpt-5.1-codex",
    name: "gpt-5.1-codex",
    description: "Optimized for codex.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high"],
    inputModalities: ["text", "image"],
    contextWindow: 272000,
    supportsParallelToolCalls: false,
    supportsVerbosity: false,
  },
  {
    id: "gpt-5.1",
    name: "gpt-5.1",
    description: "Broad world knowledge with strong general reasoning.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high"],
    inputModalities: ["text", "image"],
    contextWindow: 272000,
    supportsParallelToolCalls: true,
    supportsVerbosity: true,
  },
  {
    id: "gpt-5-codex",
    name: "gpt-5-codex",
    description: "Optimized for codex.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high"],
    inputModalities: ["text", "image"],
    contextWindow: 272000,
    supportsParallelToolCalls: false,
    supportsVerbosity: false,
  },
  {
    id: "gpt-5",
    name: "gpt-5",
    description: "Broad world knowledge with strong general reasoning.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["minimal", "low", "medium", "high"],
    inputModalities: ["text", "image"],
    contextWindow: 272000,
    supportsParallelToolCalls: false,
    supportsVerbosity: true,
  },
  {
    id: "gpt-5.1-codex-mini",
    name: "gpt-5.1-codex-mini",
    description: "Optimized for codex. Cheaper, faster, but less capable.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["medium", "high"],
    inputModalities: ["text", "image"],
    contextWindow: 272000,
    supportsParallelToolCalls: false,
    supportsVerbosity: false,
  },
  {
    id: "gpt-5-codex-mini",
    name: "gpt-5-codex-mini",
    description: "Optimized for codex. Cheaper, faster, but less capable.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["medium", "high"],
    inputModalities: ["text", "image"],
    contextWindow: 272000,
    supportsParallelToolCalls: false,
    supportsVerbosity: false,
  },
];

let installedPiAiVersionPromise: Promise<string | undefined> | undefined;

function normalizeReasoningLevel(value: unknown): ReasoningLevel | undefined {
  const normalized = normalizeNonEmptyString(value)?.toLowerCase() as ReasoningLevel | undefined;
  return normalized && REASONING_LEVELS.includes(normalized) ? normalized : undefined;
}

function normalizeReasoningLevels(values: unknown): ReasoningLevel[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const normalized: ReasoningLevel[] = [];
  const seen = new Set<ReasoningLevel>();
  for (const value of values) {
    const next =
      typeof value === "string"
        ? normalizeReasoningLevel(value)
        : normalizeReasoningLevel((value as { effort?: unknown } | null)?.effort);
    if (!next || seen.has(next)) {
      continue;
    }
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((entry) => normalizeNonEmptyString(entry))
    .filter((entry): entry is string => entry !== undefined);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function normalizeCodexModel(raw: Record<string, unknown> | null | undefined): CodexModel | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const id = normalizeNonEmptyString(raw.id ?? raw.slug);
  if (!id) {
    return null;
  }

  const supportedReasoningLevels = normalizeReasoningLevels(
    raw.supportedReasoningLevels ?? raw.supported_reasoning_levels,
  );
  if (supportedReasoningLevels.length === 0) {
    return null;
  }

  const contextWindow = normalizePositiveInteger(raw.contextWindow ?? raw.context_window);
  if (!contextWindow) {
    return null;
  }

  return {
    id,
    name: normalizeNonEmptyString(raw.name ?? raw.display_name) ?? id,
    description: normalizeNonEmptyString(raw.description) ?? id,
    defaultReasoningLevel:
      normalizeReasoningLevel(raw.defaultReasoningLevel ?? raw.default_reasoning_level) ?? "medium",
    supportedReasoningLevels,
    maxReasoningLevel: supportedReasoningLevels[supportedReasoningLevels.length - 1] ?? "medium",
    inputModalities: normalizeStringArray(raw.inputModalities ?? raw.input_modalities),
    contextWindow,
    supportsParallelToolCalls:
      raw.supportsParallelToolCalls === true || raw.supports_parallel_tool_calls === true,
    supportsVerbosity: raw.supportsVerbosity === true || raw.support_verbosity === true,
  };
}

export function getStaticCodexModels(): CodexModel[] {
  return STATIC_CODEX_MODEL_DEFINITIONS.map((entry) => ({
    ...entry,
    maxReasoningLevel: entry.supportedReasoningLevels[entry.supportedReasoningLevels.length - 1] ?? "medium",
  }));
}

async function resolveInstalledPiAiVersion(): Promise<string | undefined> {
  if (!installedPiAiVersionPromise) {
    installedPiAiVersionPromise = (async () => {
      try {
        const require = createRequire(import.meta.url);
        const entryPath = require.resolve("@mariozechner/pi-ai");
        const packageJsonPath = path.join(path.dirname(path.dirname(entryPath)), "package.json");
        const content = await fs.readFile(packageJsonPath, "utf8");
        const parsed = JSON.parse(content) as { version?: unknown };
        return normalizeNonEmptyString(parsed.version);
      } catch {
        return undefined;
      }
    })();
  }

  return installedPiAiVersionPromise;
}

export async function resolveCodexClientVersion(preferredVersion?: string): Promise<string> {
  return (
    normalizeNonEmptyString(preferredVersion) ??
    normalizeNonEmptyString(process.env.CODEX_CLIENT_VERSION) ??
    (await resolveInstalledPiAiVersion()) ??
    DEFAULT_CODEX_CLIENT_VERSION
  );
}

function summarizeHttpError(status: number, bodyText: string): string {
  const trimmed = normalizeNonEmptyString(bodyText);
  if (!trimmed) {
    return `Codex models request failed with status ${status}.`;
  }

  try {
    const parsed = JSON.parse(trimmed) as { detail?: unknown; error?: { message?: unknown } };
    const detail =
      normalizeNonEmptyString(parsed.detail) ??
      normalizeNonEmptyString(parsed.error?.message);
    if (detail) {
      return `Codex models request failed with status ${status}: ${detail}`;
    }
  } catch {
    // Ignore parse failures and fall back to the raw text snippet.
  }

  return `Codex models request failed with status ${status}: ${trimmed.slice(0, 200)}`;
}

export async function fetchLiveCodexModelCatalog(params: {
  credential: CodexCredential;
  clientVersion: string;
  userAgent?: string;
  fetchFn?: FetchLike;
}): Promise<CodexModel[]> {
  const url = new URL(DEFAULT_CODEX_MODELS_ENDPOINT);
  url.searchParams.set("client_version", params.clientVersion);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.credential.access}`,
    Accept: "application/json",
    "User-Agent": params.userAgent ?? "codex-openai-api",
  };

  const accountId = normalizeNonEmptyString(params.credential.accountId);
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  const response = await (params.fetchFn ?? fetch)(url, {
    method: "GET",
    headers,
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(summarizeHttpError(response.status, bodyText));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error("Codex models response was not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { models?: unknown[] }).models)) {
    throw new Error("Codex models response did not include a models array.");
  }

  const models = ((parsed as { models: unknown[] }).models ?? [])
    .map((entry) => normalizeCodexModel(entry as Record<string, unknown>))
    .filter((entry): entry is CodexModel => entry !== null);

  if (models.length === 0) {
    throw new Error("Codex models response did not include usable model entries.");
  }

  return models;
}
