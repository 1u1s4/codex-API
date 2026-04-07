import { normalizeNonEmptyString } from "./shared.js";
import type { GeminiModel, GeminiModelCatalog } from "./types.js";

export const DEFAULT_GEMINI_MODEL = "gemini-3.1-pro-preview";

const STATIC_GEMINI_MODELS: GeminiModel[] = [
  {
    id: "gemini-3.1-pro-preview",
    name: "gemini-3.1-pro-preview",
    description: "Gemini 3.1 Pro preview with strong reasoning and web grounding support.",
    contextWindow: 1_048_576,
    supportedBackends: ["http", "cli"],
    supportsWebSearch: true,
  },
  {
    id: "gemini-3.1-flash-preview",
    name: "gemini-3.1-flash-preview",
    description: "Gemini 3.1 Flash preview tuned for faster multimodal responses.",
    contextWindow: 1_048_576,
    supportedBackends: ["http", "cli"],
    supportsWebSearch: true,
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    name: "gemini-3.1-flash-lite-preview",
    description: "Gemini 3.1 Flash Lite preview for cheaper and faster text-first work.",
    contextWindow: 1_048_576,
    supportedBackends: ["http", "cli"],
    supportsWebSearch: true,
  },
];

const GEMINI_MODEL_ALIASES: Record<string, string> = {
  pro: "gemini-3.1-pro-preview",
  flash: "gemini-3.1-flash-preview",
  "flash-lite": "gemini-3.1-flash-lite-preview",
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
  "gemini-3-pro": "gemini-3.1-pro-preview",
  "gemini-3.1-flash": "gemini-3.1-flash-preview",
  "gemini-3-flash": "gemini-3.1-flash-preview",
  "gemini-3.1-flash-lite": "gemini-3.1-flash-lite-preview",
};

export function getStaticGeminiModels(): GeminiModel[] {
  return STATIC_GEMINI_MODELS.map((model) => ({ ...model, supportedBackends: [...model.supportedBackends] }));
}

export function normalizeGeminiModelId(model: string | undefined): string {
  const normalized = normalizeNonEmptyString(model)?.toLowerCase();
  if (!normalized) {
    return DEFAULT_GEMINI_MODEL;
  }
  return GEMINI_MODEL_ALIASES[normalized] ?? normalized;
}

export async function listGeminiModels(_params: {
  source?: "auto" | "static";
} = {}): Promise<GeminiModelCatalog> {
  return {
    source: "static",
    models: getStaticGeminiModels(),
  };
}
