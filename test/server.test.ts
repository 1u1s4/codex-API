import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexClient, CodexUpstreamError } from "../src/client.js";
import { createCodexServer } from "../src/server.js";
import type { CodexCredential, CodexModel } from "../src/types.js";

const sampleCredential: CodexCredential = {
  access: "secret_access",
  refresh: "refresh_token",
  expires: Date.now() + 60_000,
  email: "health@example.com",
  accountId: "acct_health",
};

const sampleModel: CodexModel = {
  id: "gpt-5.2",
  name: "gpt-5.2",
  description: "Test model",
  defaultReasoningLevel: "medium",
  supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
  maxReasoningLevel: "xhigh",
  inputModalities: ["text", "image"],
  contextWindow: 272000,
  supportsParallelToolCalls: true,
  supportsVerbosity: true,
};

function createAuthStub() {
  return {
    authFile: "/tmp/codex-auth.json",
    loadCredential: vi.fn(async () => sampleCredential),
    saveCredential: vi.fn(async () => {}),
    login: vi.fn(async () => sampleCredential),
    getFreshCredential: vi.fn(async () => sampleCredential),
  };
}

function createAsyncEventStream(events: Array<Record<string, unknown>>) {
  return (async function* stream() {
    for (const event of events) {
      yield event;
    }
  })();
}

async function startServer(overrides: {
  responses?: ReturnType<typeof vi.fn>;
  streamResponses?: ReturnType<typeof vi.fn>;
  listModels?: ReturnType<typeof vi.fn>;
} = {}) {
  const auth = createAuthStub();
  const client = {
    auth,
    defaultModel: "gpt-5.2",
    defaultInstructions: "You are a helpful assistant.",
    responsesEndpoint: "https://chatgpt.com/backend-api/codex/responses",
    usageEndpoint: "https://chatgpt.com/backend-api/wham/usage",
    usage: vi.fn(async () => ({
      endpoint: "https://chatgpt.com/backend-api/wham/usage",
      status: 200,
      credential: null,
      body: { ok: true },
    })),
    listModels:
      overrides.listModels ??
      vi.fn(async () => ({
        source: "static" as const,
        clientVersion: "0.64.0",
        models: [sampleModel],
      })),
    responses:
      overrides.responses ??
      vi.fn(async () => ({
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        model: "gpt-5.2",
        instructions: "You are a helpful assistant.",
        status: 200,
        credential: null,
        outputText: "Hola desde el servidor",
        responseState: {
          id: "resp_upstream",
          status: "completed",
          model: "gpt-5.2",
        },
      })),
    streamResponses:
      overrides.streamResponses ??
      vi.fn(async () => ({
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        model: "gpt-5.2",
        instructions: "You are a helpful assistant.",
        credential: null,
        events: createAsyncEventStream([
          { type: "response.output_text.delta", delta: "Hola" },
          { type: "response.output_text.delta", delta: " streaming" },
        ]),
      })),
  };

  const server = createCodexServer({
    auth,
    client: client as unknown as ReturnType<typeof createCodexClient>,
    apiKey: "local-test-key",
    host: "127.0.0.1",
    port: 0,
  });
  const started = await server.listen(0, "127.0.0.1");
  return { server, started, client };
}

const activeServers = new Set<ReturnType<typeof createCodexServer>>();

afterEach(async () => {
  for (const server of activeServers) {
    await server.close();
  }
  activeServers.clear();
});

describe("createCodexServer", () => {
  it("rejects requests without the incoming bearer key", async () => {
    const { server, started } = await startServer();
    activeServers.add(server);

    const res = await fetch(`${started.url}/healthz`);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: {
        type: "authentication_error",
      },
    });
  });

  it("serves /healthz without leaking secrets", async () => {
    const { server, started } = await startServer();
    activeServers.add(server);

    const res = await fetch(`${started.url}/healthz`, {
      headers: { Authorization: "Bearer local-test-key" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json).not.toHaveProperty("access");
    expect((json.auth as Record<string, unknown>).hasAccess).toBe(true);
    expect((json.modelCatalog as Record<string, unknown>).count).toBe(1);
  });

  it("serves /v1/models and /v1/models/:id with vendor metadata", async () => {
    const { server, started } = await startServer();
    activeServers.add(server);

    const listRes = await fetch(`${started.url}/v1/models`, {
      headers: { Authorization: "Bearer local-test-key" },
    });
    const listJson = (await listRes.json()) as { data: Array<Record<string, unknown>> };
    expect(listRes.status).toBe(200);
    expect(listJson.data[0]?.id).toBe("gpt-5.2");
    expect(listJson.data[0]?.supported_reasoning_levels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);

    const modelRes = await fetch(`${started.url}/v1/models/gpt-5.2`, {
      headers: { Authorization: "Bearer local-test-key" },
    });
    const modelJson = (await modelRes.json()) as Record<string, unknown>;
    expect(modelJson.max_reasoning_level).toBe("xhigh");
    expect(modelJson.context_window).toBe(272000);
  });

  it("serves non-streaming /v1/responses and forwards tool settings", async () => {
    const responses = vi.fn(async () => ({
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      model: "gpt-5.2",
      instructions: "system: Be brief",
      status: 200,
      credential: null,
      outputText: "Hola desde el servidor",
      responseState: {
        id: "resp_123",
        status: "completed",
        model: "gpt-5.2",
      },
    }));
    const { server, started } = await startServer({ responses });
    activeServers.add(server);

    const res = await fetch(`${started.url}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer local-test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
        input: [
          { type: "message", role: "system", content: "Be brief" },
          { type: "message", role: "user", content: "hola" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.object).toBe("response");
    expect(json.output_text).toBe("Hola desde el servidor");
    expect(responses).toHaveBeenCalledWith({
      input: [{ role: "user", content: [{ type: "input_text", text: "hola" }] }],
      instructions: "system: Be brief",
      model: "gpt-5.2",
      tools: [{ type: "web_search" }],
      toolChoice: "auto",
    });
  });

  it("streams the documented SSE event family and finishes with [DONE]", async () => {
    const streamResponses = vi.fn(async () => ({
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      model: "gpt-5.2",
      instructions: "You are a helpful assistant.",
      credential: null,
      events: createAsyncEventStream([
        { type: "response.output_text.delta", delta: "Hola" },
        { type: "response.output_text.delta", delta: " mundo" },
      ]),
    }));
    const { server, started } = await startServer({ streamResponses });
    activeServers.add(server);

    const res = await fetch(`${started.url}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer local-test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        stream: true,
        input: "hola",
      }),
    });

    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.output_text.done");
    expect(text).toContain("event: response.completed");
    expect(text).toContain("data: [DONE]");
  });

  it("returns OpenAI-style errors for malformed bodies and upstream bad requests", async () => {
    const responses = vi.fn(async () => ({
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      model: "missing-model",
      instructions: "You are a helpful assistant.",
      status: 400,
      credential: null,
      body: {
        error: {
          message: "Invalid model id.",
        },
      },
    }));
    const { server, started } = await startServer({ responses });
    activeServers.add(server);

    const malformed = await fetch(`${started.url}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer local-test-key",
        "Content-Type": "application/json",
      },
      body: "{invalid",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: {
        type: "invalid_request_error",
      },
    });

    const invalidModel = await fetch(`${started.url}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer local-test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "missing-model",
        input: "hola",
      }),
    });
    expect(invalidModel.status).toBe(400);
    await expect(invalidModel.json()).resolves.toMatchObject({
      error: {
        message: "Invalid model id.",
      },
    });
  });

  it("maps streaming upstream failures to server errors before the SSE handshake", async () => {
    const streamResponses = vi.fn(async () => {
      throw new CodexUpstreamError({
        message: "Codex stream failed upstream.",
        status: 400,
        body: { error: { message: "Bad request" } },
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        credential: null,
      });
    });
    const { server, started } = await startServer({ streamResponses });
    activeServers.add(server);

    const res = await fetch(`${started.url}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer local-test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        stream: true,
        input: "hola",
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Bad request",
      },
    });
  });
});
