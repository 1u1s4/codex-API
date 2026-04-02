import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { createCodexAuth, resolveAccountId, resolveEmail } from "../src/auth.js";
import type { CodexCredential } from "../src/types.js";

function createFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

async function createTempAuthFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-auth-test-"));
  return path.join(dir, "codex-auth.json");
}

describe("createCodexAuth", () => {
  it("saves and loads credentials", async () => {
    const authFile = await createTempAuthFile();
    const auth = createCodexAuth({ authFile });
    const access = createFakeJwt({
      "https://api.openai.com/profile": { email: "dev@example.com" },
      "https://api.openai.com/auth": { chatgpt_account_user_id: "acct_123" },
    });
    const credential: CodexCredential = {
      access,
      refresh: "refresh_token",
      expires: Date.now() + 60_000,
      email: "dev@example.com",
      accountId: "acct_123",
    };

    await auth.saveCredential(credential);
    await expect(auth.loadCredential()).resolves.toMatchObject({
      email: "dev@example.com",
      accountId: "acct_123",
      refresh: "refresh_token",
    });
  });

  it("refreshes expired credentials when a refresh token exists", async () => {
    const authFile = await createTempAuthFile();
    const expiredAccess = createFakeJwt({
      "https://api.openai.com/profile": { email: "old@example.com" },
      "https://api.openai.com/auth": { chatgpt_account_user_id: "acct_old" },
    });
    const freshAccess = createFakeJwt({
      "https://api.openai.com/profile": { email: "new@example.com" },
      "https://api.openai.com/auth": { chatgpt_account_user_id: "acct_new" },
    });
    const refreshFn = vi.fn(async () => ({
      access: freshAccess,
      refresh: "refresh_new",
      expires: Date.now() + 300_000,
    }));
    const auth = createCodexAuth({
      authFile,
      refreshFn,
    });

    await auth.saveCredential({
      access: expiredAccess,
      refresh: "refresh_old",
      expires: Date.now() - 1_000,
      email: "old@example.com",
      accountId: "acct_old",
    });

    const credential = await auth.getFreshCredential();
    expect(refreshFn).toHaveBeenCalledWith("refresh_old");
    expect(credential.email).toBe("new@example.com");
    expect(credential.accountId).toBe("acct_new");
    expect(credential.refresh).toBe("refresh_new");
  });

  it("uses ./codex-auth.json in the current working directory by default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-auth-default-"));
    const previousCwd = process.cwd();
    const previousAuthFile = process.env.CODEX_AUTH_FILE;
    const access = createFakeJwt({
      "https://api.openai.com/profile": { email: "cwd@example.com" },
      "https://api.openai.com/auth": { chatgpt_account_user_id: "acct_cwd" },
    });

    delete process.env.CODEX_AUTH_FILE;
    process.chdir(dir);

    try {
      const auth = createCodexAuth();
      expect(path.basename(auth.authFile)).toBe("codex-auth.json");
      await expect(realpath(path.dirname(auth.authFile))).resolves.toBe(await realpath(dir));

      await auth.saveCredential({
        access,
        refresh: "refresh_token",
        expires: Date.now() + 60_000,
      });

      await expect(auth.loadCredential()).resolves.toMatchObject({
        email: "cwd@example.com",
        accountId: "acct_cwd",
      });
    } finally {
      process.chdir(previousCwd);
      if (previousAuthFile === undefined) {
        delete process.env.CODEX_AUTH_FILE;
      } else {
        process.env.CODEX_AUTH_FILE = previousAuthFile;
      }
    }
  });

  it("derives account id and email from the JWT payload", () => {
    const access = createFakeJwt({
      "https://api.openai.com/profile": { email: "jwt@example.com" },
      "https://api.openai.com/auth": { chatgpt_account_user_id: "acct_jwt" },
    });
    expect(resolveEmail(access)).toBe("jwt@example.com");
    expect(resolveAccountId(access)).toBe("acct_jwt");
  });
});
