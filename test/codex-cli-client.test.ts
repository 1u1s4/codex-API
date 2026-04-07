import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createCodexClient,
  CodexUnsupportedFeatureError,
} from "../src/client.js";
import type { CodexCredential } from "../src/types.js";

const sampleCredential: CodexCredential = {
  access: "token",
  refresh: "refresh",
  expires: Date.now() + 60_000,
  email: "dev@example.com",
  accountId: "acct_123",
};

function createAuthStub(credential: CodexCredential) {
  return {
    authFile: "/tmp/codex-auth.json",
    loadCredential: vi.fn(async () => credential),
    saveCredential: vi.fn(async () => {}),
    login: vi.fn(async () => credential),
    getFreshCredential: vi.fn(async () => credential),
  };
}

describe("createCodexClient CLI backend", () => {
  it("persists CLI session ids and resumes the same logical session", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-cli-session-"));
    const sessionFile = path.join(dir, "codex-sessions.json");
    const auth = createAuthStub(sampleCredential);
    const execFileFn = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: [
          JSON.stringify({
            thread_id: "thread-1",
            item: { type: "assistant_message", text: "Hola" },
          }),
          JSON.stringify({
            item: { type: "assistant_message", text: "mundo" },
          }),
        ].join("\n"),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: "Seguimos",
        stderr: "",
      });

    const client = createCodexClient({
      auth,
      defaultBackend: "cli",
      defaultInstructions: "Reply briefly.",
      sessionFile,
      execFileFn,
      cliCommand: "codex",
    });

    const first = await client.responses({
      backend: "cli",
      model: "gpt-5.4",
      input: "Hola",
      sessionId: "chat-1",
    });
    const second = await client.responses({
      backend: "cli",
      model: "gpt-5.4",
      input: "Seguimos",
      sessionId: "chat-1",
    });

    expect(execFileFn).toHaveBeenNthCalledWith(
      1,
      "codex",
      [
        "exec",
        "--json",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--model",
        "gpt-5.4",
        "Reply briefly.\n\nHola",
      ],
      { env: process.env },
    );
    expect(execFileFn).toHaveBeenNthCalledWith(
      2,
      "codex",
      [
        "exec",
        "resume",
        "thread-1",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--model",
        "gpt-5.4",
        "Reply briefly.\n\nSeguimos",
      ],
      { env: process.env },
    );
    expect(first.outputText).toBe("Hola\nmundo");
    expect(first.responseState).toMatchObject({
      backend: "cli",
      sessionId: "thread-1",
      status: "completed",
      model: "gpt-5.4",
    });
    expect(second.outputText).toBe("Seguimos");
    expect(second.responseState).toMatchObject({
      backend: "cli",
      sessionId: "thread-1",
      status: "completed",
      model: "gpt-5.4",
    });
    expect(auth.getFreshCredential).not.toHaveBeenCalled();

    const stored = JSON.parse(await readFile(sessionFile, "utf8")) as {
      sessions: Record<string, { cliSessionId: string }>;
    };
    expect(stored.sessions["chat-1"]).toMatchObject({
      cliSessionId: "thread-1",
    });
  });

  it("retries fresh when a resumed Codex CLI session is expired", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-cli-retry-"));
    const sessionFile = path.join(dir, "codex-sessions.json");
    await writeFile(
      sessionFile,
      JSON.stringify({
        version: 1,
        sessions: {
          "chat-1": {
            cliSessionId: "thread-old",
            model: "gpt-5.4",
            updatedAt: 1,
          },
        },
      }),
      "utf8",
    );

    const execFileFn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Codex failed"), {
          stdout: "",
          stderr: "session expired",
        }),
      )
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          thread_id: "thread-new",
          item: { type: "assistant_message", text: "Recovered" },
        }),
        stderr: "",
      });

    const client = createCodexClient({
      auth: createAuthStub(sampleCredential),
      defaultBackend: "cli",
      sessionFile,
      execFileFn,
      cliCommand: "codex",
    });

    const result = await client.responses({
      backend: "cli",
      model: "gpt-5.4",
      input: "Recover",
      sessionId: "chat-1",
    });

    expect(execFileFn).toHaveBeenNthCalledWith(
      1,
      "codex",
      [
        "exec",
        "resume",
        "thread-old",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--model",
        "gpt-5.4",
        "You are a helpful assistant.\n\nRecover",
      ],
      { env: process.env },
    );
    expect(execFileFn).toHaveBeenNthCalledWith(
      2,
      "codex",
      [
        "exec",
        "--json",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--model",
        "gpt-5.4",
        "You are a helpful assistant.\n\nRecover",
      ],
      { env: process.env },
    );
    expect(result.outputText).toBe("Recovered");
    expect(result.responseState).toMatchObject({
      backend: "cli",
      sessionId: "thread-new",
      status: "completed",
    });

    const stored = JSON.parse(await readFile(sessionFile, "utf8")) as {
      sessions: Record<string, { cliSessionId: string }>;
    };
    expect(stored.sessions["chat-1"]).toMatchObject({
      cliSessionId: "thread-new",
    });
  });

  it("rejects unsupported tool and event options on the Codex CLI backend", async () => {
    const client = createCodexClient({
      auth: createAuthStub(sampleCredential),
      execFileFn: vi.fn(),
    });

    await expect(
      client.streamResponses({
        backend: "cli",
        input: "hello",
        tools: [{ type: "web_search" }],
      }),
    ).rejects.toThrow(CodexUnsupportedFeatureError);

    await expect(
      client.streamResponses({
        backend: "cli",
        input: "hello",
        toolChoice: "auto",
      }),
    ).rejects.toThrow(CodexUnsupportedFeatureError);

    await expect(
      client.responses({
        backend: "cli",
        input: "hello",
        includeEvents: true,
      }),
    ).rejects.toThrow(CodexUnsupportedFeatureError);
  });

  it("returns a normalized error when the Codex CLI binary is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-cli-missing-"));
    const sessionFile = path.join(dir, "codex-sessions.json");
    const client = createCodexClient({
      auth: createAuthStub(sampleCredential),
      defaultBackend: "cli",
      sessionFile,
      execFileFn: vi.fn(async () => {
        throw new Error("spawn codex ENOENT");
      }),
    });

    const result = await client.responses({
      backend: "cli",
      input: "hello",
    });

    expect(result.status).toBe(500);
    expect(result.endpoint).toBe("codex");
    expect(result.body).toBeNull();
  });

  it("parses partially malformed fresh JSONL output safely", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-cli-partial-"));
    const sessionFile = path.join(dir, "codex-sessions.json");
    const client = createCodexClient({
      auth: createAuthStub(sampleCredential),
      defaultBackend: "cli",
      sessionFile,
      execFileFn: vi.fn(async () => ({
        stdout: [
          "not-json",
          JSON.stringify({
            thread_id: "thread-2",
            item: { type: "assistant_message", text: "Parsed" },
          }),
        ].join("\n"),
        stderr: "",
      })),
    });

    const result = await client.responses({
      backend: "cli",
      input: "hello",
      sessionId: "chat-2",
    });

    expect(result.outputText).toBe("Parsed");
    expect(result.responseState).toMatchObject({
      backend: "cli",
      sessionId: "thread-2",
      status: "completed",
    });
  });

  it("falls back to trimmed stdout when fresh JSONL output is fully malformed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-cli-malformed-"));
    const sessionFile = path.join(dir, "codex-sessions.json");
    const client = createCodexClient({
      auth: createAuthStub(sampleCredential),
      defaultBackend: "cli",
      sessionFile,
      execFileFn: vi.fn(async () => ({
        stdout: "plain text output",
        stderr: "",
      })),
    });

    const result = await client.responses({
      backend: "cli",
      input: "hello",
    });

    expect(result.outputText).toBe("plain text output");
    expect(result.responseState).toMatchObject({
      backend: "cli",
      sessionId: null,
      status: "completed",
    });
  });
});
