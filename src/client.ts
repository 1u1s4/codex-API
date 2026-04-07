import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createCodexAuth, type CodexAuth } from "./auth.js";
import { writeJsonFileAtomic } from "./json-file.js";
import {
  fetchLiveCodexModelCatalog,
  getStaticCodexModels,
  resolveCodexClientVersion,
} from "./models.js";
import { parseJsonSse } from "./sse.js";
import { safeJson, toIsoOrNull, normalizeNonEmptyString } from "./shared.js";
import type {
  CodexBackend,
  CodexCredential,
  CodexInputMessage,
  CodexModelCatalog,
  CodexResponsesResult,
  CodexTool,
  CodexToolChoice,
  CodexUsageResult,
  CredentialSummary,
  FetchLike,
} from "./types.js";

const execFile = promisify(execFileCallback);

export const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const DEFAULT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const DEFAULT_MODEL = "gpt-5.4";
export const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";
export const DEFAULT_CODEX_SESSION_FILE = "codex-sessions.json";

type CodexCliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type CodexSessionStore = {
  version: 1;
  sessions: Record<
    string,
    {
      cliSessionId: string;
      model: string;
      updatedAt: number;
    }
  >;
};

export type CreateCodexClientOptions = {
  auth?: CodexAuth;
  authFile?: string;
  defaultModel?: string;
  defaultInstructions?: string;
  defaultBackend?: CodexBackend;
  usageEndpoint?: string;
  responsesEndpoint?: string;
  clientVersion?: string;
  userAgent?: string;
  sessionFile?: string;
  cliCommand?: string;
  fetchFn?: FetchLike;
  execFileFn?: CodexExecFile;
};

export type StreamCodexResponsesOptions = {
  input?: string | CodexInputMessage[];
  model?: string;
  instructions?: string;
  backend?: CodexBackend;
  sessionId?: string;
  tools?: CodexTool[];
  toolChoice?: CodexToolChoice;
  endpoint?: string;
  headers?: Record<string, string>;
  fetchFn?: FetchLike;
};

export class CodexUpstreamError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly endpoint: string;
  readonly credential: CredentialSummary | null;
  readonly backend: CodexBackend;

  constructor(params: {
    message: string;
    status: number;
    body: unknown;
    endpoint: string;
    credential: CredentialSummary | null;
    backend: CodexBackend;
  }) {
    super(params.message);
    this.name = "CodexUpstreamError";
    this.status = params.status;
    this.body = params.body;
    this.endpoint = params.endpoint;
    this.credential = params.credential;
    this.backend = params.backend;
  }
}

export class CodexUnsupportedFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexUnsupportedFeatureError";
  }
}

type ParsedStreamResponse = {
  endpoint: string;
  model: string;
  instructions: string;
  backend: CodexBackend;
  credential: CredentialSummary | null;
  events: AsyncGenerator<Record<string, unknown>, void, void>;
};

type ResponsesParams = StreamCodexResponsesOptions & {
  includeEvents?: boolean;
};

type CodexCliPayload = {
  text: string;
  sessionId?: string | null;
  usage?: CodexCliUsage;
  raw: unknown;
};

type CodexExecFile = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

function normalizeRawInputMessages(input: string | CodexInputMessage[] | undefined): CodexInputMessage[] {
  if (typeof input === "string") {
    const text = normalizeNonEmptyString(input) ?? "Say hello in Spanish.";
    return [
      {
        role: "user",
        content: [{ type: "input_text", text }],
      },
    ];
  }

  if (!Array.isArray(input) || input.length === 0) {
    return [
      {
        role: "user",
        content: [{ type: "input_text", text: "Say hello in Spanish." }],
      },
    ];
  }

  return input.map((message) => ({
    role: message.role,
    content: message.content
      .map((part) => ({
        type: "input_text" as const,
        text: normalizeNonEmptyString(part.text) ?? "",
      }))
      .filter((part) => part.text.length > 0),
  }));
}

function buildAuthHeaders(
  credential: CodexCredential,
  options: {
    accept?: string;
    contentType?: string;
    userAgent?: string;
    headers?: Record<string, string>;
  } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.access}`,
    Accept: options.accept ?? "application/json",
    "User-Agent": options.userAgent ?? "codex-openai-api",
    ...(options.headers ?? {}),
  };

  if (options.contentType) {
    headers["Content-Type"] = options.contentType;
  }

  const accountId = normalizeNonEmptyString(credential.accountId);
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeResponsesParams(
  inputOrOptions: string | CodexInputMessage[] | ResponsesParams,
  maybeOptions?: ResponsesParams,
): ResponsesParams {
  if (typeof inputOrOptions === "string" || Array.isArray(inputOrOptions)) {
    return { ...(maybeOptions ?? {}), input: inputOrOptions };
  }
  return inputOrOptions;
}

function normalizeCatalogSource(value: unknown): "auto" | "live" | "static" | undefined {
  const normalized = normalizeNonEmptyString(value)?.toLowerCase();
  if (normalized === "auto" || normalized === "live" || normalized === "static") {
    return normalized;
  }
  return undefined;
}

function hasUsableAccessToken(credential: CodexCredential | null): credential is CodexCredential {
  return typeof credential?.access === "string" && credential.access.trim().length > 0;
}

function hasExpired(credential: CodexCredential | null): boolean {
  return typeof credential?.expires !== "number" || Date.now() >= credential.expires;
}

export function summarizeCredential(credential: CodexCredential | null): CredentialSummary | null {
  if (!credential) {
    return null;
  }

  return {
    email: typeof credential.email === "string" ? credential.email : null,
    accountId: typeof credential.accountId === "string" ? credential.accountId : null,
    expires: typeof credential.expires === "number" ? credential.expires : null,
    expiresAt: toIsoOrNull(typeof credential.expires === "number" ? credential.expires : null),
    hasAccess: typeof credential.access === "string" && credential.access.trim().length > 0,
    hasRefresh: typeof credential.refresh === "string" && credential.refresh.trim().length > 0,
  };
}

function buildCodexCliPrompt(input: CodexInputMessage[], instructions: string): string {
  return [instructions, ...input.flatMap((message) => message.content.map((part) => part.text))]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n\n");
}

function buildCodexCliArgs(params: {
  model: string;
  prompt: string;
  cliSessionId?: string;
}): string[] {
  const baseArgs = params.cliSessionId
    ? [
        "exec",
        "resume",
        params.cliSessionId,
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
      ]
    : [
        "exec",
        "--json",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
      ];

  return [...baseArgs, "--model", params.model, params.prompt];
}

function extractCodexCliSessionId(parsed: Record<string, unknown>): string | undefined {
  const candidates = [parsed.thread_id, parsed.threadId, parsed.session_id, parsed.sessionId];
  for (const candidate of candidates) {
    const value = normalizeNonEmptyString(candidate);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function toCodexCliUsage(raw: Record<string, unknown>): CodexCliUsage | undefined {
  const pick = (key: string): number | undefined =>
    typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : undefined;

  const input = pick("input_tokens") ?? pick("inputTokens");
  const output = pick("output_tokens") ?? pick("outputTokens");
  const cacheRead =
    pick("cache_read_input_tokens") ?? pick("cached_input_tokens") ?? pick("cacheRead");
  const cacheWrite = pick("cache_write_input_tokens") ?? pick("cacheWrite");
  const total = pick("total_tokens") ?? pick("total");

  if (!input && !output && !cacheRead && !cacheWrite && !total) {
    return undefined;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
  };
}

function parseCodexCliJsonl(raw: string, fallbackSessionId?: string): CodexCliPayload | null {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  let sessionId = fallbackSessionId;
  let usage: CodexCliUsage | undefined;
  const texts: string[] = [];

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRecord(parsed)) {
      continue;
    }

    sessionId ??= extractCodexCliSessionId(parsed);

    if (isRecord(parsed.usage)) {
      usage = toCodexCliUsage(parsed.usage) ?? usage;
    }

    const item = isRecord(parsed.item) ? parsed.item : null;
    if (item && typeof item.text === "string") {
      const itemType = typeof item.type === "string" ? item.type.toLowerCase() : "";
      if (!itemType || itemType.includes("message")) {
        texts.push(item.text);
      }
    }
  }

  const text = texts.join("\n").trim();
  if (!text && !sessionId && !usage) {
    return null;
  }

  return {
    text,
    ...(sessionId ? { sessionId } : {}),
    ...(usage ? { usage } : {}),
    raw,
  };
}

function parseCodexCliOutput(params: {
  raw: string;
  outputMode: "jsonl" | "text";
  fallbackSessionId?: string;
}): CodexCliPayload {
  if (params.outputMode === "text") {
    return {
      text: params.raw.trim(),
      ...(params.fallbackSessionId ? { sessionId: params.fallbackSessionId } : {}),
      raw: params.raw,
    };
  }

  return (
    parseCodexCliJsonl(params.raw, params.fallbackSessionId) ?? {
      text: params.raw.trim(),
      ...(params.fallbackSessionId ? { sessionId: params.fallbackSessionId } : {}),
      raw: params.raw,
    }
  );
}

function extractCodexCliErrorDetails(error: unknown): {
  message: string;
  stdout: string;
  stderr: string;
} {
  if (!error || typeof error !== "object") {
    return {
      message: String(error),
      stdout: "",
      stderr: "",
    };
  }

  const rawMessage = "message" in error ? error.message : undefined;
  const rawStdout = "stdout" in error ? error.stdout : undefined;
  const rawStderr = "stderr" in error ? error.stderr : undefined;

  const stdout =
    typeof rawStdout === "string"
      ? rawStdout
      : Buffer.isBuffer(rawStdout)
        ? rawStdout.toString("utf8")
        : "";
  const stderr =
    typeof rawStderr === "string"
      ? rawStderr
      : Buffer.isBuffer(rawStderr)
        ? rawStderr.toString("utf8")
        : "";
  const message =
    typeof rawMessage === "string" && rawMessage.trim().length > 0 ? rawMessage : String(error);

  return { message, stdout, stderr };
}

function codexCliErrorText(error: CodexUpstreamError): string {
  return [error.message, typeof error.body === "string" ? error.body : JSON.stringify(error.body ?? null)]
    .filter(Boolean)
    .join("\n");
}

function isSessionExpiredErrorText(text: string): boolean {
  return /session expired/i.test(text);
}

async function loadCodexSessionStore(sessionFile: string): Promise<CodexSessionStore> {
  try {
    const text = await fs.readFile(sessionFile, "utf8");
    const parsed = JSON.parse(text) as CodexSessionStore;
    return parsed && typeof parsed === "object" && parsed.version === 1 && parsed.sessions
      ? parsed
      : { version: 1, sessions: {} };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { version: 1, sessions: {} };
    }
    throw error;
  }
}

async function saveCodexSessionStore(sessionFile: string, store: CodexSessionStore): Promise<void> {
  await writeJsonFileAtomic(sessionFile, store);
}

export function createCodexClient(options: CreateCodexClientOptions = {}) {
  const auth =
    options.auth ??
    createCodexAuth({
      authFile: options.authFile,
    });
  const userAgent = options.userAgent ?? "codex-openai-api";
  const defaultModel = options.defaultModel ?? process.env.CODEX_MODEL ?? DEFAULT_MODEL;
  const defaultInstructions =
    normalizeNonEmptyString(options.defaultInstructions) ??
    normalizeNonEmptyString(process.env.CODEX_INSTRUCTIONS) ??
    DEFAULT_INSTRUCTIONS;
  const defaultBackend = options.defaultBackend ?? "http";
  const usageEndpoint = options.usageEndpoint ?? DEFAULT_USAGE_URL;
  const responsesEndpoint =
    options.responsesEndpoint ?? process.env.CODEX_RESPONSES_URL ?? DEFAULT_RESPONSES_URL;
  const configuredClientVersion = normalizeNonEmptyString(options.clientVersion);
  const sessionFile =
    options.sessionFile ??
    process.env.CODEX_SESSION_FILE ??
    path.resolve(DEFAULT_CODEX_SESSION_FILE);
  const cliCommand =
    normalizeNonEmptyString(options.cliCommand) ??
    normalizeNonEmptyString(process.env.CODEX_CLI_PATH) ??
    "codex";
  const baseFetchFn = options.fetchFn ?? fetch;
  const execFileFn = options.execFileFn ?? execFile;

  async function runCodexCli(params: {
    model: string;
    prompt: string;
    sessionId?: string;
  }): Promise<CodexCliPayload> {
    const store = await loadCodexSessionStore(sessionFile);
    const existingCliSessionId =
      params.sessionId && store.sessions[params.sessionId]
        ? store.sessions[params.sessionId]?.cliSessionId
        : undefined;

    const executeAttempt = async (cliSessionId?: string): Promise<CodexCliPayload> => {
      const args = buildCodexCliArgs({
        model: params.model,
        prompt: params.prompt,
        ...(cliSessionId ? { cliSessionId } : {}),
      });

      let stdout: string;
      try {
        ({ stdout } = await execFileFn(cliCommand, args, { env: process.env }));
      } catch (error) {
        const details = extractCodexCliErrorDetails(error);
        const body = safeJson(
          normalizeNonEmptyString(details.stderr) ?? normalizeNonEmptyString(details.stdout) ?? "",
        );
        const detailText =
          normalizeNonEmptyString(details.stderr) ??
          normalizeNonEmptyString(details.stdout) ??
          details.message;
        throw new CodexUpstreamError({
          message: `Codex CLI execution failed: ${detailText}`,
          status: 500,
          body,
          endpoint: cliCommand,
          credential: null,
          backend: "cli",
        });
      }

      return parseCodexCliOutput({
        raw: stdout,
        outputMode: cliSessionId ? "text" : "jsonl",
        ...(cliSessionId ? { fallbackSessionId: cliSessionId } : {}),
      });
    };

    let payload: CodexCliPayload;
    try {
      payload = await executeAttempt(existingCliSessionId);
    } catch (error) {
      if (
        existingCliSessionId &&
        error instanceof CodexUpstreamError &&
        isSessionExpiredErrorText(codexCliErrorText(error))
      ) {
        payload = await executeAttempt(undefined);
      } else {
        throw error;
      }
    }

    if (params.sessionId && payload.sessionId) {
      store.sessions[params.sessionId] = {
        cliSessionId: payload.sessionId,
        model: params.model,
        updatedAt: Date.now(),
      };
      await saveCodexSessionStore(sessionFile, store);
    }

    return payload;
  }

  async function usage(params: { endpoint?: string; headers?: Record<string, string> } = {}): Promise<CodexUsageResult> {
    const credential = await auth.getFreshCredential();
    const endpoint = params.endpoint ?? usageEndpoint;
    const response = await baseFetchFn(endpoint, {
      method: "GET",
      headers: buildAuthHeaders(credential, {
        userAgent,
        accept: "application/json",
        headers: params.headers,
      }),
    });
    const body = await response.text();

    return {
      endpoint,
      status: response.status,
      credential: summarizeCredential(credential),
      body: safeJson(body),
    };
  }

  async function streamResponses(params: StreamCodexResponsesOptions = {}): Promise<ParsedStreamResponse> {
    const backend = params.backend ?? defaultBackend;
    const model = params.model ?? defaultModel;
    const instructions =
      normalizeNonEmptyString(params.instructions) ?? defaultInstructions;
    const input = normalizeRawInputMessages(params.input);

    if (backend === "cli") {
      if (params.tools && params.tools.length > 0) {
        throw new CodexUnsupportedFeatureError(
          "Codex CLI backend v1 does not support tools. Use backend: \"http\" for web_search or upstream tools.",
        );
      }
      if (params.toolChoice !== undefined) {
        throw new CodexUnsupportedFeatureError(
          "Codex CLI backend v1 does not support toolChoice.",
        );
      }

      const payload = await runCodexCli({
        model,
        prompt: buildCodexCliPrompt(input, instructions),
        sessionId: params.sessionId,
      });

      async function* cliEvents(): AsyncGenerator<Record<string, unknown>, void, void> {
        if (payload.text) {
          yield { type: "response.output_text.delta", delta: payload.text };
        }
        yield {
          type: "response.completed",
          response: {
            id: null,
            status: "completed",
            model,
            sessionId: payload.sessionId ?? null,
            backend: "cli",
          },
        };
      }

      return {
        endpoint: cliCommand,
        model,
        instructions,
        backend,
        credential: null,
        events: cliEvents(),
      };
    }

    const credential = await auth.getFreshCredential();
    const endpoint = params.endpoint ?? responsesEndpoint;
    const requestBody = {
      model,
      store: false,
      stream: true,
      instructions,
      input,
      ...(params.tools !== undefined ? { tools: params.tools } : {}),
      ...(params.toolChoice !== undefined ? { tool_choice: params.toolChoice } : {}),
    };
    const response = await (params.fetchFn ?? baseFetchFn)(endpoint, {
      method: "POST",
      headers: buildAuthHeaders(credential, {
        userAgent,
        accept: "text/event-stream",
        contentType: "application/json",
        headers: {
          "OpenAI-Beta": "responses=experimental",
          originator: "pi",
          ...(params.headers ?? {}),
        },
      }),
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      const body = safeJson(bodyText);
      throw new CodexUpstreamError({
        message: `Codex responses request failed with status ${response.status}.`,
        status: response.status,
        body,
        endpoint,
        credential: summarizeCredential(credential),
        backend,
      });
    }

    return {
      endpoint,
      model,
      instructions,
      backend,
      credential: summarizeCredential(credential),
      events: parseJsonSse(response),
    };
  }

  async function responses(
    inputOrOptions: string | CodexInputMessage[] | ResponsesParams,
    maybeOptions?: ResponsesParams,
  ): Promise<CodexResponsesResult> {
    const params = normalizeResponsesParams(inputOrOptions, maybeOptions);
    const backend = params.backend ?? defaultBackend;

    if (backend === "cli" && params.includeEvents) {
      throw new CodexUnsupportedFeatureError(
        "Codex CLI backend v1 does not support includeEvents.",
      );
    }

    try {
      const stream = await streamResponses(params);
      const events: unknown[] = [];
      let outputText = "";
      let responseState: CodexResponsesResult["responseState"] = null;

      for await (const event of stream.events) {
        if (params.includeEvents) {
          events.push(event);
        }

        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          outputText += event.delta;
          continue;
        }

        if (
          (event.type === "response.completed" ||
            event.type === "response.done" ||
            event.type === "response.incomplete") &&
          event.response &&
          typeof event.response === "object"
        ) {
          const response = event.response as Record<string, unknown>;
          responseState = {
            id: typeof response.id === "string" ? response.id : null,
            status: typeof response.status === "string" ? response.status : null,
            model: typeof response.model === "string" ? response.model : stream.model,
            backend: stream.backend,
            sessionId: typeof response.sessionId === "string" ? response.sessionId : null,
          };
        }
      }

      return {
        endpoint: stream.endpoint,
        model: stream.model,
        instructions: stream.instructions,
        status: 200,
        credential: stream.credential,
        outputText,
        responseState,
        ...(params.includeEvents ? { events } : {}),
      };
    } catch (error) {
      if (error instanceof CodexUpstreamError) {
        return {
          endpoint: error.endpoint,
          model: params.model ?? defaultModel,
          instructions:
            normalizeNonEmptyString(params.instructions) ?? defaultInstructions,
          status: error.status,
          credential: error.credential,
          body: error.body,
        };
      }
      throw error;
    }
  }

  async function resolveLiveCatalogCredential(
    source: "auto" | "live" | "static",
  ): Promise<CodexCredential | null> {
    const stored = await auth.loadCredential();
    if (!hasUsableAccessToken(stored)) {
      if (source === "auto") {
        return null;
      }
      throw new Error("No stored Codex credential. Run login first.");
    }

    if (!hasExpired(stored)) {
      return stored;
    }

    if (typeof stored.refresh === "string" && stored.refresh.trim().length > 0) {
      return await auth.getFreshCredential();
    }

    if (source === "auto") {
      return null;
    }
    throw new Error("Stored Codex credential is expired and cannot be refreshed.");
  }

  async function listModels(params: {
    source?: "auto" | "live" | "static";
    clientVersion?: string;
    fetchFn?: FetchLike;
  } = {}): Promise<CodexModelCatalog> {
    const source = normalizeCatalogSource(params.source) ?? "auto";
    const clientVersion = await resolveCodexClientVersion(
      normalizeNonEmptyString(params.clientVersion) ?? configuredClientVersion,
    );

    if (source === "static") {
      return { source: "static", clientVersion, models: getStaticCodexModels() };
    }

    try {
      const credential = await resolveLiveCatalogCredential(source);
      if (!credential) {
        return { source: "static", clientVersion, models: getStaticCodexModels() };
      }

      const models = await fetchLiveCodexModelCatalog({
        credential,
        clientVersion,
        userAgent,
        fetchFn: params.fetchFn ?? baseFetchFn,
      });
      return { source: "live", clientVersion, models };
    } catch (error) {
      if (source === "live") {
        throw error;
      }
      return { source: "static", clientVersion, models: getStaticCodexModels() };
    }
  }

  return {
    auth,
    defaultModel,
    defaultInstructions,
    defaultBackend,
    usageEndpoint,
    responsesEndpoint,
    sessionFile,
    cliCommand,
    usage,
    listModels,
    responses,
    streamResponses,
  };
}
