import { createCodexAuth, type CodexAuth } from "./auth.js";
import {
  fetchLiveCodexModelCatalog,
  getStaticCodexModels,
  resolveCodexClientVersion,
} from "./models.js";
import { safeJson, toIsoOrNull, normalizeNonEmptyString } from "./shared.js";
import type {
  CodexCredential,
  CodexInputMessage,
  CodexModelCatalog,
  CodexResponsesResult,
  CodexUsageResult,
  CredentialSummary,
  FetchLike,
} from "./types.js";

export const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const DEFAULT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const DEFAULT_MODEL = "gpt-5.4";
export const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

export type CreateCodexClientOptions = {
  auth?: CodexAuth;
  authFile?: string;
  defaultModel?: string;
  defaultInstructions?: string;
  usageEndpoint?: string;
  responsesEndpoint?: string;
  clientVersion?: string;
  userAgent?: string;
  fetchFn?: FetchLike;
};

export type StreamCodexResponsesOptions = {
  input?: string | CodexInputMessage[];
  model?: string;
  instructions?: string;
  endpoint?: string;
  headers?: Record<string, string>;
  fetchFn?: FetchLike;
};

export class CodexUpstreamError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly endpoint: string;
  readonly credential: CredentialSummary | null;

  constructor(params: {
    message: string;
    status: number;
    body: unknown;
    endpoint: string;
    credential: CredentialSummary | null;
  }) {
    super(params.message);
    this.name = "CodexUpstreamError";
    this.status = params.status;
    this.body = params.body;
    this.endpoint = params.endpoint;
    this.credential = params.credential;
  }
}

type ParsedStreamResponse = {
  endpoint: string;
  model: string;
  instructions: string;
  credential: CredentialSummary | null;
  events: AsyncGenerator<Record<string, unknown>, void, void>;
};

type ResponsesParams = StreamCodexResponsesOptions & {
  includeEvents?: boolean;
};

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

function splitSseFrames(buffer: string): { frames: string[]; remaining: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames: string[] = [];
  let cursor = 0;
  let separatorIndex = normalized.indexOf("\n\n", cursor);
  while (separatorIndex !== -1) {
    frames.push(normalized.slice(cursor, separatorIndex));
    cursor = separatorIndex + 2;
    separatorIndex = normalized.indexOf("\n\n", cursor);
  }
  return {
    frames,
    remaining: normalized.slice(cursor),
  };
}

async function* parseSse(response: Response): AsyncGenerator<Record<string, unknown>, void, void> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parsed = splitSseFrames(buffer);
      buffer = parsed.remaining;

      for (const frame of parsed.frames) {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();

        if (!data || data === "[DONE]") {
          continue;
        }

        try {
          const parsedEvent = JSON.parse(data);
          if (parsedEvent && typeof parsedEvent === "object") {
            yield parsedEvent as Record<string, unknown>;
          }
        } catch {
          // Ignore malformed fragments in the standalone wrapper.
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation failures during shutdown.
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore release failures during shutdown.
    }
  }
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
  const usageEndpoint = options.usageEndpoint ?? DEFAULT_USAGE_URL;
  const responsesEndpoint =
    options.responsesEndpoint ?? process.env.CODEX_RESPONSES_URL ?? DEFAULT_RESPONSES_URL;
  const configuredClientVersion = normalizeNonEmptyString(options.clientVersion);
  const baseFetchFn = options.fetchFn;

  async function usage(params: { endpoint?: string; headers?: Record<string, string> } = {}): Promise<CodexUsageResult> {
    const credential = await auth.getFreshCredential();
    const endpoint = params.endpoint ?? usageEndpoint;
    const response = await (baseFetchFn ?? fetch)(endpoint, {
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
    const credential = await auth.getFreshCredential();
    const endpoint = params.endpoint ?? responsesEndpoint;
    const model = params.model ?? defaultModel;
    const instructions =
      normalizeNonEmptyString(params.instructions) ?? defaultInstructions;
    const input = normalizeRawInputMessages(params.input);
    const response = await (params.fetchFn ?? baseFetchFn ?? fetch)(endpoint, {
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
      body: JSON.stringify({
        model,
        store: false,
        stream: true,
        instructions,
        input,
      }),
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
      });
    }

    return {
      endpoint,
      model,
      instructions,
      credential: summarizeCredential(credential),
      events: parseSse(response),
    };
  }

  async function responses(
    inputOrOptions: string | CodexInputMessage[] | ResponsesParams,
    maybeOptions?: ResponsesParams,
  ): Promise<CodexResponsesResult> {
    const params = normalizeResponsesParams(inputOrOptions, maybeOptions);

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
            model: typeof response.model === "string" ? response.model : null,
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
    usageEndpoint,
    responsesEndpoint,
    usage,
    listModels,
    responses,
    streamResponses,
  };
}
