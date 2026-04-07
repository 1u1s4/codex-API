import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createGeminiClient,
  GeminiUnsupportedFeatureError,
} from "../src/gemini-client.js";
import type { GeminiCredential } from "../src/types.js";

const sampleCredential: GeminiCredential = {
  access: "token",
  refresh: "refresh",
  expires: Date.now() + 60_000,
  email: "dev@example.com",
  projectId: "project-123",
};

function createAuthStub(credential: GeminiCredential) {
  return {
    authFile: "/tmp/gemini-auth.json",
    loadCredential: vi.fn(async () => credential),
    saveCredential: vi.fn(async () => {}),
    login: vi.fn(async () => credential),
    getFreshCredential: vi.fn(async () => credential),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

describe("createGeminiClient", () => {
  it("returns the static Gemini model catalog in v1", async () => {
    const client = createGeminiClient({
      auth: createAuthStub(sampleCredential),
    });

    const catalog = await client.listModels({ source: "auto" });

    expect(catalog.source).toBe("static");
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.models[0]?.supportedBackends).toContain("http");
    expect(catalog.models[0]?.supportedBackends).toContain("cli");
  });

  it("maps HTTP responses, web_search, and raw SSE events", async () => {
    const auth = createAuthStub(sampleCredential);
    let requestUrl = "";
    let requestBody: unknown;

    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body ?? "{}"));

      expect(init?.headers).toMatchObject({
        Authorization: "Bearer token",
        "x-goog-user-project": "project-123",
      });

      return new Response(
        [
          'data: {"candidates":[{"content":{"parts":[{"text":"Hola "}]}}]}',
          'data: {"candidates":[{"content":{"parts":[{"text":"mundo"}]}}]}',
          'data: {"type":"response.completed","response":{"id":"resp_http","status":"completed","model":"gemini-3.1-flash-preview"}}',
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

    const client = createGeminiClient({
      auth,
      fetchFn,
      defaultInstructions: "Answer briefly.",
    });

    const result = await client.responses({
      model: "flash",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: "Use citations when possible." }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "What changed today?" }],
        },
      ],
      tools: [{ type: "web_search" }],
      toolChoice: "auto",
      includeEvents: true,
    });

    expect(requestUrl).toContain("/models/gemini-3.1-flash-preview:streamGenerateContent?alt=sse");
    expect(requestBody).toEqual({
      contents: [
        {
          role: "user",
          parts: [{ text: "What changed today?" }],
        },
      ],
      systemInstruction: {
        parts: [{ text: "Answer briefly.\n\nUse citations when possible." }],
      },
      tools: [{ google_search: {} }],
    });
    expect(result.model).toBe("gemini-3.1-flash-preview");
    expect(result.outputText).toBe("Hola mundo");
    expect(result.responseState).toMatchObject({
      id: "resp_http",
      status: "completed",
      model: "gemini-3.1-flash-preview",
      backend: "http",
      sessionId: null,
    });
    expect(result.events).toHaveLength(3);
  });

  it("normalizes usage buckets into Pro and Flash windows", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer token",
        "x-goog-user-project": "project-123",
      });
      return jsonResponse({
        buckets: [
          { modelId: "gemini-3.1-pro-preview", remainingFraction: 0.25 },
          { modelId: "gemini-3.1-flash-preview", remainingFraction: 0.6 },
        ],
      });
    });

    const client = createGeminiClient({
      auth: createAuthStub(sampleCredential),
      fetchFn,
    });

    const result = await client.usage();

    expect(result.status).toBe(200);
    expect(result.windows).toEqual([
      { label: "Pro", usedPercent: 75 },
      { label: "Flash", usedPercent: 40 },
    ]);
  });

  it("returns normalized upstream errors for HTTP requests", async () => {
    const client = createGeminiClient({
      auth: createAuthStub(sampleCredential),
      fetchFn: vi.fn(async () =>
        jsonResponse(
          {
            error: {
              message: "Rate limited",
            },
          },
          429,
        )),
    });

    const result = await client.responses({
      backend: "http",
      model: "pro",
      input: "hello",
    });

    expect(result.status).toBe(429);
    expect(result.model).toBe("gemini-3.1-pro-preview");
    expect(result.body).toEqual({
      error: {
        message: "Rate limited",
      },
    });
  });

  it("rejects unsupported HTTP tools outside web_search", async () => {
    const client = createGeminiClient({
      auth: createAuthStub(sampleCredential),
      fetchFn: vi.fn(),
    });

    await expect(
      client.responses({
        backend: "http",
        input: "hello",
        tools: [{ type: "code_interpreter" }],
      }),
    ).rejects.toThrow(GeminiUnsupportedFeatureError);
  });

  it("persists CLI session ids and resumes the same logical session", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gemini-cli-session-"));
    const sessionFile = path.join(dir, "gemini-sessions.json");
    const execFileFn = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          text: "Hola",
          sessionId: "cli-session-1",
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          text: "Seguimos",
          sessionId: "cli-session-1",
        }),
        stderr: "",
      });

    const client = createGeminiClient({
      auth: createAuthStub(sampleCredential),
      defaultBackend: "cli",
      sessionFile,
      execFileFn,
      cliCommand: "gemini",
    });

    const first = await client.responses({
      backend: "cli",
      model: "pro",
      input: "Hola",
      sessionId: "chat-1",
    });
    const second = await client.responses({
      backend: "cli",
      model: "pro",
      input: "Seguimos",
      sessionId: "chat-1",
    });

    expect(execFileFn).toHaveBeenNthCalledWith(
      1,
      "gemini",
      [
        "--prompt",
        "You are a helpful assistant.\n\nHola",
        "--output-format",
        "json",
        "--model",
        "gemini-3.1-pro-preview",
      ],
      { env: process.env },
    );
    expect(execFileFn).toHaveBeenNthCalledWith(
      2,
      "gemini",
      [
        "--resume",
        "cli-session-1",
        "--prompt",
        "You are a helpful assistant.\n\nSeguimos",
        "--output-format",
        "json",
        "--model",
        "gemini-3.1-pro-preview",
      ],
      { env: process.env },
    );
    expect(first.responseState).toMatchObject({
      backend: "cli",
      sessionId: "cli-session-1",
      status: "completed",
    });
    expect(second.outputText).toBe("Seguimos");

    const stored = JSON.parse(await readFile(sessionFile, "utf8")) as {
      sessions: Record<string, { cliSessionId: string }>;
    };
    expect(stored.sessions["chat-1"]).toMatchObject({
      cliSessionId: "cli-session-1",
    });
  });

  it("rejects CLI-only unsupported tool and event options", async () => {
    const client = createGeminiClient({
      auth: createAuthStub(sampleCredential),
      execFileFn: vi.fn(),
    });

    await expect(
      client.streamResponses({
        backend: "cli",
        input: "hello",
        tools: [{ type: "web_search" }],
      }),
    ).rejects.toThrow(GeminiUnsupportedFeatureError);

    await expect(
      client.responses({
        backend: "cli",
        input: "hello",
        includeEvents: true,
      }),
    ).rejects.toThrow(GeminiUnsupportedFeatureError);
  });

  it("returns a normalized error when the Gemini CLI binary is missing", async () => {
    const client = createGeminiClient({
      auth: createAuthStub(sampleCredential),
      defaultBackend: "cli",
      execFileFn: vi.fn(async () => {
        throw new Error("spawn gemini ENOENT");
      }),
    });

    const result = await client.responses({
      backend: "cli",
      input: "hello",
    });

    expect(result.status).toBe(500);
    expect(result.endpoint).toBe("gemini");
    expect(result.body).toBeNull();
  });

  it("returns a normalized error when the Gemini CLI emits malformed JSON", async () => {
    const client = createGeminiClient({
      auth: createAuthStub(sampleCredential),
      defaultBackend: "cli",
      execFileFn: vi.fn(async () => ({
        stdout: "not-json",
        stderr: "",
      })),
    });

    const result = await client.responses({
      backend: "cli",
      input: "hello",
    });

    expect(result.status).toBe(500);
    expect(result.endpoint).toBe("gemini");
    expect(result.body).toBe("not-json");
  });
});
