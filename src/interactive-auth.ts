import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { normalizeNonEmptyString } from "./shared.js";

export type BrowserAuthInfo = {
  url: string;
  instructions?: string;
};

export type InteractiveAuthCallbacks = {
  onAuth?: (params: BrowserAuthInfo) => Promise<void> | void;
  onPrompt?: (params: {
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
  }) => Promise<string> | string;
  onManualCodeInput?: () => Promise<string> | string;
  onProgress?: (message: string) => Promise<void> | void;
};

async function ask(prompt: string, options: { placeholder?: string; allowEmpty?: boolean } = {}) {
  const rl = createInterface({ input, output });
  const suffix = normalizeNonEmptyString(options.placeholder);
  const message = suffix ? `${prompt} (${suffix}): ` : `${prompt}: `;

  try {
    const answer = await rl.question(message);
    return options.allowEmpty ? answer : answer.trim();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ABORT_ERR") {
      const aborted = new Error("Prompt aborted.");
      Object.assign(aborted, { code: "ABORT_ERR" });
      throw aborted;
    }
    throw error;
  } finally {
    rl.close();
  }
}

export function createDefaultInteractiveAuthCallbacks(
  overrides: InteractiveAuthCallbacks = {},
  options: {
    authTitle: string;
    defaultManualPrompt: string;
  },
): Required<InteractiveAuthCallbacks> {
  return {
    onAuth:
      overrides.onAuth ??
      (({ url, instructions }) => {
        console.log("");
        console.log(`Open this URL for ${options.authTitle}:`);
        console.log(url);
        const note = normalizeNonEmptyString(instructions);
        if (note) {
          console.log("");
          console.log(note);
        }
        console.log("");
      }),
    onPrompt:
      overrides.onPrompt ??
      (({ message, placeholder, allowEmpty }) =>
        ask(message, { placeholder, allowEmpty })),
    onManualCodeInput:
      overrides.onManualCodeInput ??
      (() =>
        ask(options.defaultManualPrompt, {
          placeholder: "code or redirect URL",
        })),
    onProgress:
      overrides.onProgress ??
      ((message) => {
        const normalized = normalizeNonEmptyString(message);
        if (normalized) {
          console.log(normalized);
        }
      }),
  };
}
