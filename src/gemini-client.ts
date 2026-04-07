import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createGeminiAuth, type GeminiAuth } from "./gemini-auth.js";
import { DEFAULT_GEMINI_MODEL, listGeminiModels, normalizeGeminiModelId } from "./gemini-models.js";
import { writeJsonFileAtomic } from "./json-file.js";
import { parseJsonSse } from "./sse.js";
import { normalizeNonEmptyString, safeJson, toIsoOrNull } from "./shared.js";
import type {
  CodexInputMessage,
  CodexTool,
  CodexToolChoice,
  FetchLike,
  GeminiBackend,
  GeminiCredential,
  GeminiCredentialSummary,
  GeminiModelCatalog,
  GeminiResponsesResult,
  GeminiUsageResult,
  GeminiUsageWindow,
} from "./types.js";

const execFile = promisify(execFileCallback);

export const DEFAULT_GEMINI_USAGE_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
export const DEFAULT_GEMINI_RESPONSES_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_INSTRUCTIONS = "You are a helpful assistant.";
export const DEFAULT_GEMINI_SESSION_FILE = "gemini-sessions.json";

type GeminiSessionStore = {
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

type ParsedGeminiStreamResponse = {
  endpoint: string;
  model: string;
  instructions: string;
  backend: GeminiBackend;
  credential: GeminiCredentialSummary | null;
  events: AsyncGenerator<Record<string, unknown>, void, void>;
};

type GeminiExecFile = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export type CreateGeminiClientOptions = {
  auth?: GeminiAuth;
  authFile?: string;
  defaultModel?: string;
  defaultInstructions?: string;
  defaultBackend?: GeminiBackend;
  usageEndpoint?: string;
  responsesBaseUrl?: string;
  userAgent?: string;
  sessionFile?: string;
  cliCommand?: string;
  fetchFn?: FetchLike;
  execFileFn?: GeminiExecFile;
};

export type StreamGeminiResponsesOptions = {
  input?: string | CodexInputMessage[];
  model?: string;
  instructions?: string;
  backend?: GeminiBackend;
  sessionId?: string;
  tools?: CodexTool[];
  toolChoice?: CodexToolChoice;
  endpoint?: string;
  headers?: Record<string, string>;
  fetchFn?: FetchLike;
};

type GeminiResponsesOptions = StreamGeminiResponsesOptions & {
  includeEvents?: boolean;
};

type GeminiCliPayload = {
  text: string;
  sessionId?: string | null;
  raw: unknown;
};

type GeminiGenerateContentEvent = Record<string, unknown>;

export class GeminiUpstreamError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly endpoint: string;
  readonly credential: GeminiCredentialSummary | null;
  readonly backend: GeminiBackend;

  constructor(params: {
    message: string;
    status: number;
    body: unknown;
    endpoint: string;
    credential: GeminiCredentialSummary | null;
    backend: GeminiBackend;
  }) {
    super(params.message);
    this.name = "GeminiUpstreamError";
    this.status = params.status;
    this.body = params.body;
    this.endpoint = params.endpoint;
    this.credential = params.credential;
    this.backend = params.backend;
  }
}

export class GeminiUnsupportedFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiUnsupportedFeatureError";
  }
}

function summarizeGeminiCredential(credential: GeminiCredential | null): GeminiCredentialSummary | null {
  if (!credential) {
    return null;
  }
  return {
    email: typeof credential.email === "string" ? credential.email : null,
    projectId: typeof credential.projectId === "string" ? credential.projectId : null,
    expires: typeof credential.expires === "number" ? credential.expires : null,
    expiresAt: toIsoOrNull(typeof credential.expires === "number" ? credential.expires : null),
    hasAccess: typeof credential.access === "string" && credential.access.trim().length > 0,
    hasRefresh: typeof credential.refresh === "string" && credential.refresh.trim().length > 0,
  };
}

function normalizeRawInputMessages(input: string | CodexInputMessage[] | undefined): CodexInputMessage[] {
  if (typeof input === "string") {
    const text = normalizeNonEmptyString(input) ?? "Say hello.";
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
        content: [{ type: "input_text", text: "Say hello." }],
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

function buildGeminiHeaders(
  credential: GeminiCredential,
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

  const projectId = normalizeNonEmptyString(credential.projectId);
  if (projectId) {
    headers["x-goog-user-project"] = projectId;
  }

  return headers;
}

function normalizeResponsesParams(
  inputOrOptions: string | CodexInputMessage[] | GeminiResponsesOptions,
  maybeOptions?: GeminiResponsesOptions,
): GeminiResponsesOptions {
  if (typeof inputOrOptions === "string" || Array.isArray(inputOrOptions)) {
    return { ...(maybeOptions ?? {}), input: inputOrOptions };
  }
  return inputOrOptions;
}

function normalizeGeminiCatalogSource(value: unknown): "auto" | "static" | undefined {
  const normalized = normalizeNonEmptyString(value)?.toLowerCase();
  if (normalized === "auto" || normalized === "static") {
    return normalized;
  }
  return undefined;
}

function toGeminiContents(input: CodexInputMessage[]): {
  contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
  instructionText?: string;
} {
  const instructionChunks: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

  for (const message of input) {
    const text = message.content.map((part) => part.text).join("\n").trim();
    if (!text) {
      continue;
    }
    if (message.role === "system" || message.role === "developer") {
      instructionChunks.push(text);
      continue;
    }
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text }],
    });
  }

  return {
    contents,
    ...(instructionChunks.length > 0 ? { instructionText: instructionChunks.join("\n\n") } : {}),
  };
}

function resolveGeminiWebSearchTool(params: {
  tools?: CodexTool[];
  toolChoice?: CodexToolChoice;
}): Array<{ google_search: Record<string, never> }> | undefined {
  if (!params.tools || params.tools.length === 0) {
    return undefined;
  }

  const unsupportedTool = params.tools.find((tool) => normalizeNonEmptyString(tool.type) !== "web_search");
  if (unsupportedTool) {
    throw new GeminiUnsupportedFeatureError(
      `Gemini HTTP v1 only supports tools: [{ type: "web_search" }]. Unsupported tool: ${String(unsupportedTool.type)}`,
    );
  }

  if (typeof params.toolChoice === "object") {
    throw new GeminiUnsupportedFeatureError(
      "Gemini HTTP v1 does not support object-valued toolChoice overrides.",
    );
  }

  if (params.toolChoice === "none") {
    return undefined;
  }

  return [{ google_search: {} }];
}

function extractGeminiEventText(event: GeminiGenerateContentEvent): string {
  if (typeof event.delta === "string") {
    return event.delta;
  }
  if (typeof event.text === "string") {
    return event.text;
  }

  const candidates = Array.isArray(event.candidates) ? event.candidates : [];
  const parts = candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const content =
      "content" in candidate && candidate.content && typeof candidate.content === "object"
        ? (candidate.content as { parts?: unknown }).parts
        : undefined;
    return Array.isArray(content)
      ? content
          .map((part) => {
            if (!part || typeof part !== "object" || !("text" in part)) {
              return undefined;
            }
            const text = (part as { text?: unknown }).text;
            return typeof text === "string" && text.length > 0 ? text : undefined;
          })
          .filter((value): value is string => Boolean(value))
      : [];
  });

  return parts.join("");
}

function extractGeminiCliSessionId(payload: Record<string, unknown>): string | undefined {
  const candidates = [
    payload.session_id,
    payload.sessionId,
    payload.conversation_id,
    payload.conversationId,
    payload.thread_id,
    payload.threadId,
  ];
  for (const candidate of candidates) {
    const value = normalizeNonEmptyString(candidate);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function extractGeminiCliText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => extractGeminiCliText(entry)).filter(Boolean).join("\n");
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = [
    "text",
    "output_text",
    "response",
    "content",
    "message",
    "result",
  ] as const;

  for (const key of preferredKeys) {
    const nested = extractGeminiCliText(record[key]);
    if (nested) {
      return nested;
    }
  }

  if (Array.isArray(record.parts)) {
    return record.parts.map((entry) => extractGeminiCliText(entry)).filter(Boolean).join("\n");
  }

  if (Array.isArray(record.candidates)) {
    return record.candidates
      .map((entry) => extractGeminiCliText(entry))
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

async function loadGeminiSessionStore(sessionFile: string): Promise<GeminiSessionStore> {
  try {
    const text = await import("node:fs/promises").then((fs) => fs.readFile(sessionFile, "utf8"));
    const parsed = JSON.parse(text) as GeminiSessionStore;
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

async function saveGeminiSessionStore(sessionFile: string, store: GeminiSessionStore): Promise<void> {
  await writeJsonFileAtomic(sessionFile, store);
}

async function runGeminiCli(params: {
  command: string;
  sessionFile: string;
  sessionId?: string;
  model: string;
  prompt: string;
  execFileFn: GeminiExecFile;
}): Promise<GeminiCliPayload> {
  const store = await loadGeminiSessionStore(params.sessionFile);
  const sessionEntry =
    params.sessionId && store.sessions[params.sessionId] ? store.sessions[params.sessionId] : undefined;

  const args = sessionEntry?.cliSessionId
    ? ["--resume", sessionEntry.cliSessionId, "--prompt", params.prompt, "--output-format", "json"]
    : ["--prompt", params.prompt, "--output-format", "json"];
  args.push("--model", params.model);

  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await params.execFileFn(params.command, args, { env: process.env }));
  } catch (error) {
    throw new GeminiUpstreamError({
      message: `Gemini CLI execution failed: ${error instanceof Error ? error.message : String(error)}`,
      status: 500,
      body: null,
      endpoint: params.command,
      credential: null,
      backend: "cli",
    });
  }

  const combined = normalizeNonEmptyString(stdout) ?? normalizeNonEmptyString(stderr);
  if (!combined) {
    throw new GeminiUpstreamError({
      message: "Gemini CLI did not produce output.",
      status: 500,
      body: null,
      endpoint: params.command,
      credential: null,
      backend: "cli",
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(combined);
  } catch {
    throw new GeminiUpstreamError({
      message: "Gemini CLI returned malformed JSON.",
      status: 500,
      body: combined,
      endpoint: params.command,
      credential: null,
      backend: "cli",
    });
  }

  const payload = raw as Record<string, unknown>;
  const sessionId = extractGeminiCliSessionId(payload);
  if (params.sessionId && sessionId) {
    store.sessions[params.sessionId] = {
      cliSessionId: sessionId,
      model: params.model,
      updatedAt: Date.now(),
    };
    await saveGeminiSessionStore(params.sessionFile, store);
  }

  return {
    text: extractGeminiCliText(payload),
    ...(sessionId ? { sessionId } : {}),
    raw,
  };
}

export function createGeminiClient(options: CreateGeminiClientOptions = {}) {
  const auth =
    options.auth ??
    createGeminiAuth({
      authFile: options.authFile,
    });
  const userAgent = options.userAgent ?? "codex-openai-api";
  const defaultModel = normalizeGeminiModelId(
    options.defaultModel ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
  );
  const defaultInstructions =
    normalizeNonEmptyString(options.defaultInstructions) ??
    normalizeNonEmptyString(process.env.GEMINI_INSTRUCTIONS) ??
    DEFAULT_GEMINI_INSTRUCTIONS;
  const defaultBackend = options.defaultBackend ?? "http";
  const usageEndpoint = options.usageEndpoint ?? DEFAULT_GEMINI_USAGE_URL;
  const responsesBaseUrl =
    options.responsesBaseUrl ?? process.env.GEMINI_RESPONSES_BASE_URL ?? DEFAULT_GEMINI_RESPONSES_BASE_URL;
  const sessionFile =
    options.sessionFile ??
    process.env.GEMINI_SESSION_FILE ??
    path.resolve(DEFAULT_GEMINI_SESSION_FILE);
  const cliCommand =
    normalizeNonEmptyString(options.cliCommand) ??
    normalizeNonEmptyString(process.env.GEMINI_CLI_PATH) ??
    "gemini";
  const baseFetchFn = options.fetchFn ?? fetch;
  const execFileFn = options.execFileFn ?? execFile;

  async function usage(params: {
    endpoint?: string;
    headers?: Record<string, string>;
    fetchFn?: FetchLike;
  } = {}): Promise<GeminiUsageResult> {
    const credential = await auth.getFreshCredential();
    const endpoint = params.endpoint ?? usageEndpoint;
    const response = await (params.fetchFn ?? baseFetchFn)(endpoint, {
      method: "POST",
      headers: buildGeminiHeaders(credential, {
        userAgent,
        accept: "application/json",
        contentType: "application/json",
        headers: params.headers,
      }),
      body: "{}",
    });

    const bodyText = await response.text();
    const body = safeJson(bodyText);
    const windows: GeminiUsageWindow[] = [];

    if (body && typeof body === "object" && Array.isArray((body as { buckets?: unknown[] }).buckets)) {
      let proMin = 1;
      let flashMin = 1;
      let hasPro = false;
      let hasFlash = false;

      for (const bucket of (body as { buckets: unknown[] }).buckets) {
        if (!bucket || typeof bucket !== "object") {
          continue;
        }
        const modelId = normalizeNonEmptyString((bucket as { modelId?: unknown }).modelId) ?? "unknown";
        const remainingFraction =
          typeof (bucket as { remainingFraction?: unknown }).remainingFraction === "number"
            ? (bucket as { remainingFraction: number }).remainingFraction
            : 1;
        const lower = modelId.toLowerCase();

        if (lower.includes("pro")) {
          hasPro = true;
          proMin = Math.min(proMin, remainingFraction);
        }
        if (lower.includes("flash")) {
          hasFlash = true;
          flashMin = Math.min(flashMin, remainingFraction);
        }
      }

      if (hasPro) {
        windows.push({ label: "Pro", usedPercent: Math.max(0, Math.min(100, (1 - proMin) * 100)) });
      }
      if (hasFlash) {
        windows.push({
          label: "Flash",
          usedPercent: Math.max(0, Math.min(100, (1 - flashMin) * 100)),
        });
      }
    }

    return {
      endpoint,
      status: response.status,
      credential: summarizeGeminiCredential(credential),
      windows,
      body,
    };
  }

  async function streamResponses(
    params: StreamGeminiResponsesOptions = {},
  ): Promise<ParsedGeminiStreamResponse> {
    const backend = params.backend ?? defaultBackend;
    const model = normalizeGeminiModelId(params.model ?? defaultModel);
    const instructions =
      normalizeNonEmptyString(params.instructions) ?? defaultInstructions;
    const input = normalizeRawInputMessages(params.input);

    if (backend === "cli") {
      if (params.tools && params.tools.length > 0) {
        throw new GeminiUnsupportedFeatureError(
          "Gemini CLI backend v1 does not support tools. Use backend: \"http\" for web_search.",
        );
      }
      if (params.toolChoice !== undefined) {
        throw new GeminiUnsupportedFeatureError(
          "Gemini CLI backend v1 does not support toolChoice.",
        );
      }

      const promptParts = [instructions, ...input.flatMap((message) => message.content.map((part) => part.text))]
        .map((value) => value.trim())
        .filter(Boolean);
      const payload = await runGeminiCli({
        command: cliCommand,
        sessionFile,
        sessionId: params.sessionId,
        model,
        prompt: promptParts.join("\n\n"),
        execFileFn,
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
    const endpoint =
      params.endpoint ??
      `${responsesBaseUrl.replace(/\/+$/, "")}/models/${model}:streamGenerateContent?alt=sse`;

    const { contents, instructionText } = toGeminiContents(input);
    const tools = resolveGeminiWebSearchTool({
      tools: params.tools,
      toolChoice: params.toolChoice,
    });

    const response = await (params.fetchFn ?? baseFetchFn)(endpoint, {
      method: "POST",
      headers: buildGeminiHeaders(credential, {
        userAgent,
        accept: "text/event-stream",
        contentType: "application/json",
        headers: params.headers,
      }),
      body: JSON.stringify({
        contents,
        ...(instructionText || instructions
          ? {
              systemInstruction: {
                parts: [{ text: [instructions, instructionText].filter(Boolean).join("\n\n") }],
              },
            }
          : {}),
        ...(tools ? { tools } : {}),
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new GeminiUpstreamError({
        message: `Gemini HTTP request failed with status ${response.status}.`,
        status: response.status,
        body: safeJson(bodyText),
        endpoint,
        credential: summarizeGeminiCredential(credential),
        backend,
      });
    }

    return {
      endpoint,
      model,
      instructions,
      backend,
      credential: summarizeGeminiCredential(credential),
      events: parseJsonSse(response),
    };
  }

  async function responses(
    inputOrOptions: string | CodexInputMessage[] | GeminiResponsesOptions,
    maybeOptions?: GeminiResponsesOptions,
  ): Promise<GeminiResponsesResult> {
    const params = normalizeResponsesParams(inputOrOptions, maybeOptions);
    const backend = params.backend ?? defaultBackend;

    if (backend === "cli" && params.includeEvents) {
      throw new GeminiUnsupportedFeatureError(
        "Gemini CLI backend v1 does not support includeEvents.",
      );
    }

    try {
      const stream = await streamResponses(params);
      const events: unknown[] = [];
      let outputText = "";
      let responseState: GeminiResponsesResult["responseState"] = null;

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
          continue;
        }

        if (stream.backend === "http") {
          outputText += extractGeminiEventText(event);
        }
      }

      return {
        endpoint: stream.endpoint,
        model: stream.model,
        instructions: stream.instructions,
        backend: stream.backend,
        status: 200,
        credential: stream.credential,
        outputText,
        responseState,
        ...(params.includeEvents ? { events } : {}),
      };
    } catch (error) {
      if (error instanceof GeminiUpstreamError) {
        return {
          endpoint: error.endpoint,
          model: normalizeGeminiModelId(params.model ?? defaultModel),
          instructions:
            normalizeNonEmptyString(params.instructions) ?? defaultInstructions,
          backend: backend,
          status: error.status,
          credential: error.credential,
          body: error.body,
        };
      }
      throw error;
    }
  }

  async function listModels(params: { source?: "auto" | "static" } = {}): Promise<GeminiModelCatalog> {
    const source = normalizeGeminiCatalogSource(params.source) ?? "auto";
    void source;
    return await listGeminiModels({ source: "static" });
  }

  return {
    auth,
    defaultModel,
    defaultInstructions,
    defaultBackend,
    usageEndpoint,
    responsesBaseUrl,
    sessionFile,
    cliCommand,
    usage,
    listModels,
    responses,
    streamResponses,
  };
}
