#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createCodexAuth } from "./auth.js";
import { createCodexClient, summarizeCredential } from "./client.js";
import { createCodexServer } from "./server.js";

function toCamelCase(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const trimmed = arg.slice(2);
    const equalIndex = trimmed.indexOf("=");
    const key = toCamelCase(equalIndex === -1 ? trimmed : trimmed.slice(0, equalIndex));
    if (!key) {
      continue;
    }

    if (equalIndex !== -1) {
      flags[key] = trimmed.slice(equalIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next != null && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
      continue;
    }

    flags[key] = true;
  }

  return { positional, flags };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function buildUsageError(): string {
  return [
    "Use:",
    "  codex-openai-api login",
    "  codex-openai-api dry",
    "  codex-openai-api list-models [--source auto|live|static] [--client-version VALUE]",
    "  codex-openai-api usage [--endpoint URL]",
    "  codex-openai-api responses [prompt] [--instructions TEXT] [--model ID] [--endpoint URL]",
    "  codex-openai-api serve [--host 127.0.0.1] [--port 8787] [--api-key VALUE]",
  ].join("\n");
}

function parsePort(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const auth = createCodexAuth();
  const client = createCodexClient({ auth });
  const command = argv[0] ?? "dry";
  const { positional, flags } = parseArgs(argv.slice(1));

  if (command === "dry") {
    await fs.mkdir(path.dirname(auth.authFile), { recursive: true });
    const credential = await auth.loadCredential();
    printJson({
      command: "dry",
      cwd: process.cwd(),
      authFile: auth.authFile,
      credential: summarizeCredential(credential),
    });
    return;
  }

  if (command === "login") {
    const credential = await auth.login();
    printJson({
      command: "login",
      authFile: auth.authFile,
      credential: summarizeCredential(credential),
    });
    return;
  }

  if (command === "usage") {
    const result = await client.usage({
      endpoint: typeof flags.endpoint === "string" ? flags.endpoint : undefined,
    });
    printJson({ command: "usage", ...result });
    return;
  }

  if (command === "list-models") {
    const result = await client.listModels({
      source: typeof flags.source === "string" ? (flags.source as "auto" | "live" | "static") : undefined,
      clientVersion: typeof flags.clientVersion === "string" ? flags.clientVersion : undefined,
    });
    printJson({ command: "list-models", ...result });
    return;
  }

  if (command === "responses") {
    const result = await client.responses({
      input: positional.join(" "),
      instructions: typeof flags.instructions === "string" ? flags.instructions : undefined,
      model: typeof flags.model === "string" ? flags.model : undefined,
      endpoint: typeof flags.endpoint === "string" ? flags.endpoint : undefined,
    });
    printJson({ command: "responses", ...result });
    return;
  }

  if (command === "serve") {
    const server = createCodexServer({
      auth,
      host: typeof flags.host === "string" ? flags.host : undefined,
      port: parsePort(flags.port),
      apiKey: typeof flags.apiKey === "string" ? flags.apiKey : undefined,
    });
    const started = await server.listen();
    printJson({
      command: "serve",
      authFile: auth.authFile,
      host: started.host,
      port: started.port,
      url: started.url,
    });

    const shutdown = async () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      await server.close();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await new Promise<void>((resolve, reject) => {
      server.server.once("close", resolve);
      server.server.once("error", reject);
    });
    return;
  }

  throw new Error(buildUsageError());
}

try {
  await runCli();
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ABORT_ERR") {
    console.error("Prompt aborted.");
    process.exitCode = 130;
  } else if (error instanceof Error) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
