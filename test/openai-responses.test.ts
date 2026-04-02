import { describe, expect, it } from "vitest";
import {
  buildOpenAiModelObject,
  createOpenAiResponseResource,
  translateOpenAiResponseRequest,
} from "../src/openai-responses.js";

describe("translateOpenAiResponseRequest", () => {
  it("translates a plain string input into one user message", () => {
    const translated = translateOpenAiResponseRequest({
      model: "gpt-5.2",
      input: "hola",
    });

    expect(translated.model).toBe("gpt-5.2");
    expect(translated.stream).toBe(false);
    expect(translated.inputMessages).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "hola" }],
      },
    ]);
  });

  it("merges system and developer items into instructions", () => {
    const translated = translateOpenAiResponseRequest({
      model: "gpt-5.2",
      instructions: "Base system prompt",
      input: [
        { type: "message", role: "system", content: "System rules" },
        { type: "message", role: "developer", content: "Developer rules" },
        { type: "message", role: "assistant", content: "Previous answer" },
        { type: "message", role: "user", content: "Current question" },
      ],
    });

    expect(translated.instructions).toBe(
      "Base system prompt\n\nsystem: System rules\n\ndeveloper: Developer rules",
    );
    expect(translated.inputMessages).toEqual([
      {
        role: "assistant",
        content: [{ type: "input_text", text: "Previous answer" }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "Current question" }],
      },
    ]);
  });

  it("builds an OpenAI-style response resource and model object", () => {
    const response = createOpenAiResponseResource({
      id: "resp_123",
      model: "gpt-5.2",
      status: "completed",
      outputText: "Hola",
    });
    const model = buildOpenAiModelObject({
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
    });

    expect(response).toMatchObject({
      id: "resp_123",
      object: "response",
      status: "completed",
      model: "gpt-5.2",
      output_text: "Hola",
    });
    expect(model).toMatchObject({
      id: "gpt-5.2",
      object: "model",
      default_reasoning_level: "medium",
      max_reasoning_level: "xhigh",
      input_modalities: ["text", "image"],
    });
  });
});
