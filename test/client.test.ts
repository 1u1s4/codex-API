import { describe, expect, it, vi } from "vitest";
import { createCodexClient } from "../src/client.js";
import type { CodexCredential, CodexInputMessage } from "../src/types.js";

const sampleCredential: CodexCredential = {
  access: "token",
  refresh: "refresh",
  expires: Date.now() + 60_000,
  email: "dev@example.com",
  accountId: "acct_123",
};

function createAuthStub(credential: CodexCredential | null) {
  return {
    authFile: "/tmp/codex-auth.json",
    loadCredential: vi.fn(async () => credential),
    saveCredential: vi.fn(async () => {}),
    login: vi.fn(async () => {
      if (!credential) {
        throw new Error("No credential available");
      }
      return credential;
    }),
    getFreshCredential: vi.fn(async () => {
      if (!credential) {
        throw new Error("No credential available");
      }
      return credential;
    }),
  };
}

describe("createCodexClient", () => {
  it("falls back to the static model catalog when no credential is stored", async () => {
    const auth = createAuthStub(null);
    const client = createCodexClient({ auth });
    const catalog = await client.listModels({ source: "auto" });

    expect(catalog.source).toBe("static");
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.models[0]?.supportedReasoningLevels.length).toBeGreaterThan(0);
  });

  it("sends normalized upstream payloads for responses", async () => {
    const auth = createAuthStub(sampleCredential);
    const input: CodexInputMessage[] = [
      {
        role: "user",
        content: [{ type: "input_text", text: "hola" }],
      },
    ];
    let requestBody: unknown;
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"Hola"}',
          'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.2"}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        },
      );
    });
    const client = createCodexClient({
      auth,
      fetchFn,
      defaultModel: "gpt-5.2",
      defaultInstructions: "Reply briefly.",
    });

    const result = await client.responses({
      input,
      includeEvents: true,
    });

    expect(requestBody).toMatchObject({
      model: "gpt-5.2",
      stream: true,
      instructions: "Reply briefly.",
      input,
    });
    expect(requestBody).not.toHaveProperty("tools");
    expect(requestBody).not.toHaveProperty("tool_choice");
    expect(result.outputText).toBe("Hola");
    expect(result.responseState).toMatchObject({
      id: "resp_1",
      status: "completed",
      model: "gpt-5.2",
      backend: "http",
      sessionId: null,
    });
    expect(result.events).toHaveLength(2);
  });

  it("passes tools and tool_choice through to the upstream payload", async () => {
    const auth = createAuthStub(sampleCredential);
    let requestBody: unknown;
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"Result"}',
          'data: {"type":"response.completed","response":{"id":"resp_tools","status":"completed","model":"gpt-5.4"}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        },
      );
    });
    const client = createCodexClient({
      auth,
      fetchFn,
    });

    const result = await client.responses({
      model: "gpt-5.4",
      input: "What happened today?",
      tools: [{ type: "web_search" }],
      toolChoice: "auto",
    });

    expect(requestBody).toEqual({
      model: "gpt-5.4",
      store: false,
      stream: true,
      instructions: "You are a helpful assistant.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "What happened today?" }],
        },
      ],
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
    });
    expect(result.outputText).toBe("Result");
    expect(result.responseState).toMatchObject({
      id: "resp_tools",
      status: "completed",
      model: "gpt-5.4",
      backend: "http",
      sessionId: null,
    });
  });

  it("passes reasoning through to the upstream payload", async () => {
    const auth = createAuthStub(sampleCredential);
    let requestBody: unknown;
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"Fast"}',
          'data: {"type":"response.completed","response":{"id":"resp_reasoning","status":"completed","model":"gpt-5.4"}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        },
      );
    });
    const client = createCodexClient({
      auth,
      fetchFn,
    });

    const result = await client.responses({
      model: "gpt-5.4",
      input: "Answer quickly",
      reasoningEffort: "low",
    });

    expect(requestBody).toEqual({
      model: "gpt-5.4",
      store: false,
      stream: true,
      instructions: "You are a helpful assistant.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Answer quickly" }],
        },
      ],
      reasoning: { effort: "low" },
    });
    expect(result.outputText).toBe("Fast");
    expect(result.responseState).toMatchObject({
      id: "resp_reasoning",
      status: "completed",
      model: "gpt-5.4",
      backend: "http",
      sessionId: null,
    });
  });

  it("refreshes expired credentials before fetching the live model catalog", async () => {
    const expiredCredential: CodexCredential = {
      ...sampleCredential,
      access: "expired_token",
      expires: Date.now() - 1_000,
    };
    const freshCredential: CodexCredential = {
      ...sampleCredential,
      access: "fresh_token",
      expires: Date.now() + 60_000,
    };
    const auth = {
      authFile: "/tmp/codex-auth.json",
      loadCredential: vi.fn(async () => expiredCredential),
      saveCredential: vi.fn(async () => {}),
      login: vi.fn(async () => freshCredential),
      getFreshCredential: vi.fn(async () => freshCredential),
    };
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer fresh_token",
        "ChatGPT-Account-Id": "acct_123",
      });

      return new Response(
        JSON.stringify({
          models: [
            {
              id: "gpt-5.4",
              name: "gpt-5.4",
              description: "Live model",
              default_reasoning_level: "medium",
              supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
              input_modalities: ["text", "image"],
              context_window: 272000,
              supports_parallel_tool_calls: true,
              support_verbosity: true,
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    });
    const client = createCodexClient({
      auth,
      fetchFn,
    });

    const catalog = await client.listModels({ source: "live", clientVersion: "0.64.0" });

    expect(auth.getFreshCredential).toHaveBeenCalledTimes(1);
    expect(catalog.source).toBe("live");
    expect(catalog.models[0]?.id).toBe("gpt-5.4");
  });
});
