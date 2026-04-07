import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAuth, type CodexAuth } from "./auth.js";
import {
  CodexUpstreamError,
  createCodexClient,
  summarizeCredential,
  type CreateCodexClientOptions,
} from "./client.js";
import {
  buildOpenAiErrorPayload,
  buildOpenAiModelObject,
  buildResponseStreamCompletion,
  buildResponseStreamFailure,
  buildResponseStreamPrelude,
  createOpenAiResponseResource,
  createResponseStreamContext,
  OpenAiRequestError,
  translateOpenAiResponseRequest,
} from "./openai-responses.js";
import { normalizeNonEmptyString, safeJson } from "./shared.js";
import type { CodexModel, CodexResponsesResult } from "./types.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_SERVER_PORT = 8787;
const DEFAULT_MAX_BODY_BYTES = 1_000_000;

type CodexClient = ReturnType<typeof createCodexClient>;

export type CreateCodexServerOptions = CreateCodexClientOptions & {
  apiKey?: string;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  auth?: CodexAuth;
  client?: CodexClient;
};

type PackageInfo = {
  name: string;
  version: string;
};

type StartedServer = {
  host: string;
  port: number;
  url: string;
};

function buildUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload, "utf8"));
  res.end(payload);
}

function writeOpenAiError(
  res: ServerResponse,
  status: number,
  message: string,
  type = "invalid_request_error",
): void {
  writeJson(res, status, buildOpenAiErrorPayload(message, type));
}

function setSseHeaders(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
}

function writeSseEvent(res: ServerResponse, payload: Record<string, unknown>): void {
  const eventName = typeof payload.type === "string" ? payload.type : "message";
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeDone(res: ServerResponse): void {
  res.write("data: [DONE]\n\n");
  res.end();
}

function resolvePackageInfoPath(): string {
  return path.join(PACKAGE_ROOT, "package.json");
}

async function loadPackageInfo(): Promise<PackageInfo> {
  try {
    const content = await fs.readFile(resolvePackageInfoPath(), "utf8");
    const parsed = JSON.parse(content) as { name?: unknown; version?: unknown };
    return {
      name: typeof parsed.name === "string" ? parsed.name : "codex-openai-api",
      version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
    };
  } catch {
    return { name: "codex-openai-api", version: "0.0.0" };
  }
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new OpenAiRequestError("Request body is too large.", 413);
    }
    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  const trimmedBody = normalizeNonEmptyString(rawBody);
  if (!trimmedBody) {
    throw new OpenAiRequestError("Request body is required.");
  }

  try {
    return JSON.parse(trimmedBody);
  } catch {
    throw new OpenAiRequestError("Request body must be valid JSON.");
  }
}

function isAuthorizedRequest(req: IncomingMessage, apiKey: string): boolean {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") {
    return false;
  }
  const [scheme, token] = raw.split(/\s+/, 2);
  return scheme === "Bearer" && token === apiKey;
}

function mapModelById(models: CodexModel[], modelId: string): CodexModel | null {
  return models.find((model) => model.id === modelId) ?? null;
}

function isRecoverableBadRequest(error: unknown): error is CodexUpstreamError {
  return error instanceof CodexUpstreamError && error.status === 400;
}

function buildResponseUsageFromText(text: string) {
  return {
    input_tokens: 0,
    output_tokens: text.length > 0 ? 1 : 0,
    total_tokens: text.length > 0 ? 1 : 0,
  };
}

export function createCodexServer(options: CreateCodexServerOptions = {}) {
  const apiKey =
    normalizeNonEmptyString(options.apiKey) ??
    normalizeNonEmptyString(process.env.CODEX_SERVER_API_KEY);
  if (!apiKey) {
    throw new Error("Missing CODEX_SERVER_API_KEY. Set it before starting the server.");
  }

  const host =
    normalizeNonEmptyString(options.host) ??
    normalizeNonEmptyString(process.env.CODEX_SERVER_HOST) ??
    DEFAULT_SERVER_HOST;
  const port =
    typeof options.port === "number"
      ? options.port
      : Number.parseInt(process.env.CODEX_SERVER_PORT ?? "", 10) || DEFAULT_SERVER_PORT;
  const maxBodyBytes =
    typeof options.maxBodyBytes === "number" ? options.maxBodyBytes : DEFAULT_MAX_BODY_BYTES;
  const auth = options.auth ?? createCodexAuth({ authFile: options.authFile });
  const client = options.client ?? createCodexClient({ ...options, auth });
  const packageInfoPromise = loadPackageInfo();
  const server = createHttpServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", buildUrl(host, port));
      const pathname = requestUrl.pathname;

      if (!isAuthorizedRequest(req, apiKey)) {
        writeOpenAiError(res, 401, "Missing or invalid bearer token.", "authentication_error");
        return;
      }

      if (req.method === "GET" && pathname === "/healthz") {
        const credential = await auth.loadCredential();
        let modelCatalog:
          | { ok: true; source: string; count: number }
          | { ok: false; error: string };

        try {
          const catalog = await client.listModels({ source: "auto" });
          modelCatalog = {
            ok: true,
            source: catalog.source,
            count: catalog.models.length,
          };
        } catch (error) {
          modelCatalog = {
            ok: false,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }

        const packageInfo = await packageInfoPromise;
        writeJson(res, 200, {
          ok: true,
          auth: summarizeCredential(credential),
          modelCatalog,
          server: {
            name: packageInfo.name,
            version: packageInfo.version,
            host,
            port,
          },
        });
        return;
      }

      if (
        req.method === "GET" &&
        (pathname === "/v1/models" || pathname.startsWith("/v1/models/"))
      ) {
        const catalog = await client.listModels({ source: "auto" });
        if (pathname === "/v1/models") {
          writeJson(res, 200, {
            object: "list",
            data: catalog.models.map(buildOpenAiModelObject),
          });
          return;
        }

        const encodedId = pathname.slice("/v1/models/".length);
        const modelId = decodeURIComponent(encodedId);
        const model = mapModelById(catalog.models, modelId);
        if (!model) {
          writeOpenAiError(res, 404, `Model '${modelId}' not found.`);
          return;
        }

        writeJson(res, 200, buildOpenAiModelObject(model));
        return;
      }

      if (req.method === "POST" && pathname === "/v1/responses") {
        const rawBody = await readJsonBody(req, maxBodyBytes);
        const translated = translateOpenAiResponseRequest(rawBody);

        if (translated.stream) {
          const stream = await client.streamResponses({
            input: translated.inputMessages,
            instructions: translated.instructions,
            model: translated.model,
            tools: translated.tools,
            toolChoice: translated.toolChoice,
          });
          const context = createResponseStreamContext(stream.model);
          let outputText = "";

          setSseHeaders(res);
          for (const event of buildResponseStreamPrelude(context)) {
            writeSseEvent(res, event);
          }

          try {
            for await (const event of stream.events) {
              if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                outputText += event.delta;
                writeSseEvent(res, {
                  type: "response.output_text.delta",
                  item_id: context.outputItemId,
                  output_index: 0,
                  content_index: 0,
                  delta: event.delta,
                });
                continue;
              }

              if (event.type === "response.failed") {
                const message =
                  typeof (event as { response?: { error?: { message?: unknown } } }).response?.error
                    ?.message === "string"
                    ? (event as { response: { error: { message: string } } }).response.error.message
                    : "Codex upstream stream failed.";
                writeSseEvent(
                  res,
                  buildResponseStreamFailure({
                    context,
                    message,
                  }),
                );
                writeDone(res);
                return;
              }
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Codex upstream stream failed.";
            writeSseEvent(
              res,
              buildResponseStreamFailure({
                context,
                message,
              }),
            );
            writeDone(res);
            return;
          }

          for (const event of buildResponseStreamCompletion({
            context,
            outputText,
            usage: buildResponseUsageFromText(outputText),
          })) {
            writeSseEvent(res, event);
          }
          writeDone(res);
          return;
        }

        const result: CodexResponsesResult = await client.responses({
          input: translated.inputMessages,
          instructions: translated.instructions,
          model: translated.model,
          tools: translated.tools,
          toolChoice: translated.toolChoice,
        });

        if (result.status >= 400) {
          const message =
            typeof (result.body as { error?: { message?: unknown } } | null)?.error?.message ===
            "string"
              ? (result.body as { error: { message: string } }).error.message
              : `Codex upstream request failed with status ${result.status}.`;
          const status = result.status === 400 ? 400 : 502;
          writeOpenAiError(
            res,
            status,
            message,
            status === 400 ? "invalid_request_error" : "server_error",
          );
          return;
        }

        writeJson(
          res,
          200,
          createOpenAiResponseResource({
            id: result.responseState?.id ?? undefined,
            model: result.model,
            status: "completed",
            outputText: result.outputText ?? "",
            usage: buildResponseUsageFromText(result.outputText ?? ""),
          }),
        );
        return;
      }

      if (
        pathname === "/v1/responses" ||
        pathname === "/v1/models" ||
        pathname.startsWith("/v1/models/")
      ) {
        writeOpenAiError(
          res,
          405,
          `Method ${req.method ?? "UNKNOWN"} not allowed.`,
          "invalid_request_error",
        );
        return;
      }

      writeOpenAiError(res, 404, `Path '${pathname}' not found.`);
    } catch (error) {
      if (error instanceof OpenAiRequestError) {
        writeOpenAiError(res, error.status, error.message, error.type);
        return;
      }

      if (isRecoverableBadRequest(error)) {
        const message =
          typeof error.body === "object" &&
          error.body &&
          "error" in (error.body as Record<string, unknown>)
            ? typeof (error.body as { error?: { message?: unknown } }).error?.message === "string"
              ? (error.body as { error: { message: string } }).error.message
              : error.message
            : error.message;
        writeOpenAiError(res, 400, message);
        return;
      }

      const message =
        error instanceof Error
          ? error.message
          : `Unexpected server error: ${String(safeJson(String(error)))}`;
      writeOpenAiError(res, 500, message, "server_error");
    }
  });

  async function listen(listenPort = port, listenHost = host): Promise<StartedServer> {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, listenHost, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not resolve server address.");
    }

    return {
      host: listenHost,
      port: address.port,
      url: buildUrl(listenHost, address.port),
    };
  }

  async function close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  return {
    host,
    port,
    server,
    auth,
    client,
    listen,
    close,
  };
}
