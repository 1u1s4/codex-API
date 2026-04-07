import { randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizeNonEmptyString } from "./shared.js";
import type { CodexInputMessage, CodexModel, CodexTool, CodexToolChoice } from "./types.js";

const TextPartSchema = z
  .object({
    type: z.enum(["input_text", "output_text", "text"]),
    text: z.string(),
  })
  .passthrough();

const MessageItemSchema = z
  .object({
    type: z.literal("message"),
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: z.union([z.string(), z.array(TextPartSchema)]),
  })
  .passthrough();

const ToolSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const ToolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({
    type: z.string(),
  }).passthrough(),
]);

export const CreateOpenAiResponseRequestSchema = z
  .object({
    model: z.string().optional(),
    input: z.union([z.string(), z.array(MessageItemSchema)]),
    instructions: z.string().optional(),
    stream: z.boolean().optional(),
    user: z.string().optional(),
    store: z.boolean().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    previous_response_id: z.string().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    reasoning: z
      .object({
        effort: z.enum(["low", "medium", "high"]).optional(),
        summary: z.enum(["auto", "concise", "detailed"]).optional(),
      })
      .optional(),
    tools: z.array(ToolSchema).optional(),
    tool_choice: ToolChoiceSchema.optional(),
    toolChoice: ToolChoiceSchema.optional(),
  })
  .passthrough();

export type OpenAiCreateResponseRequest = z.infer<typeof CreateOpenAiResponseRequestSchema>;

export type OpenAiResponseErrorPayload = {
  error: {
    message: string;
    type: string;
  };
};

export type OpenAiResponseResource = {
  id: string;
  object: "response";
  created_at: number;
  status: "in_progress" | "completed" | "failed";
  model: string;
  output: Array<{
    type: "message";
    id: string;
    role: "assistant";
    content: Array<{ type: "output_text"; text: string }>;
    status: "in_progress" | "completed";
  }>;
  output_text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  error?: {
    message: string;
    type: string;
  };
};

export type ResponseStreamContext = {
  responseId: string;
  outputItemId: string;
  model: string;
  createdAt: number;
};

export class OpenAiRequestError extends Error {
  readonly status: number;
  readonly type: string;

  constructor(message: string, status = 400, type = "invalid_request_error") {
    super(message);
    this.name = "OpenAiRequestError";
    this.status = status;
    this.type = type;
  }
}

function extractTextContent(
  content: string | Array<{ type: "input_text" | "output_text" | "text"; text: string }>,
): string {
  if (typeof content === "string") {
    return normalizeNonEmptyString(content) ?? "";
  }

  return content
    .map((part) => normalizeNonEmptyString(part.text) ?? "")
    .filter((part) => part.length > 0)
    .join("\n");
}

export function translateOpenAiResponseRequest(rawBody: unknown): {
  model?: string;
  instructions?: string;
  stream: boolean;
  user?: string;
  tools?: CodexTool[];
  toolChoice?: CodexToolChoice;
  inputMessages: CodexInputMessage[];
} {
  const body = CreateOpenAiResponseRequestSchema.parse(rawBody);
  const toolChoice = body.toolChoice ?? body.tool_choice;

  if (typeof body.input === "string") {
    const text = normalizeNonEmptyString(body.input);
    if (!text) {
      throw new OpenAiRequestError("`input` must not be empty.");
    }

    return {
      model: normalizeNonEmptyString(body.model),
      instructions: normalizeNonEmptyString(body.instructions),
      stream: body.stream === true,
      user: normalizeNonEmptyString(body.user),
      ...(Array.isArray(body.tools) ? { tools: body.tools as CodexTool[] } : {}),
      ...(toolChoice ? { toolChoice: toolChoice as CodexToolChoice } : {}),
      inputMessages: [{ role: "user", content: [{ type: "input_text", text }] }],
    };
  }

  const instructionsParts = [normalizeNonEmptyString(body.instructions)].filter(
    (entry): entry is string => entry !== undefined,
  );
  const inputMessages: CodexInputMessage[] = [];
  let sawUserMessage = false;

  for (const item of body.input) {
    const text = extractTextContent(item.content);
    if (!text) {
      continue;
    }

    if (item.role === "system" || item.role === "developer") {
      instructionsParts.push(`${item.role}: ${text}`);
      continue;
    }

    if (item.role === "user") {
      sawUserMessage = true;
    }

    inputMessages.push({
      role: item.role,
      content: [{ type: "input_text", text }],
    });
  }

  if (!sawUserMessage) {
    throw new OpenAiRequestError("`input` must include at least one user text message.");
  }

  return {
    model: normalizeNonEmptyString(body.model),
    instructions: instructionsParts.length > 0 ? instructionsParts.join("\n\n") : undefined,
    stream: body.stream === true,
    user: normalizeNonEmptyString(body.user),
    ...(Array.isArray(body.tools) ? { tools: body.tools as CodexTool[] } : {}),
    ...(toolChoice ? { toolChoice: toolChoice as CodexToolChoice } : {}),
    inputMessages,
  };
}

export function createUsage(
  usage: Partial<OpenAiResponseResource["usage"]> = {},
): OpenAiResponseResource["usage"] {
  const inputTokens = Number.isFinite(usage.input_tokens) ? usage.input_tokens ?? 0 : 0;
  const outputTokens = Number.isFinite(usage.output_tokens) ? usage.output_tokens ?? 0 : 0;
  const totalTokens =
    Number.isFinite(usage.total_tokens) && (usage.total_tokens ?? 0) >= 0
      ? usage.total_tokens ?? 0
      : inputTokens + outputTokens;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

export function createAssistantOutputItem(params: {
  id?: string;
  text: string;
  status?: "in_progress" | "completed";
}): OpenAiResponseResource["output"][number] {
  return {
    type: "message",
    id: params.id ?? `msg_${randomUUID()}`,
    role: "assistant",
    content: [{ type: "output_text", text: params.text }],
    status: params.status ?? "completed",
  };
}

export function createOpenAiResponseResource(params: {
  id?: string;
  model: string;
  status: OpenAiResponseResource["status"];
  outputText?: string;
  usage?: Partial<OpenAiResponseResource["usage"]>;
  error?: { message: string; type: string };
  outputItemId?: string;
  createdAt?: number;
}): OpenAiResponseResource {
  const createdAt = params.createdAt ?? Math.floor(Date.now() / 1000);
  const outputText = params.outputText ?? "";
  const output =
    params.status === "in_progress" && outputText.length === 0
      ? []
      : [
          createAssistantOutputItem({
            id: params.outputItemId,
            text: outputText,
            status: params.status === "completed" ? "completed" : "in_progress",
          }),
        ];

  return {
    id: params.id ?? `resp_${randomUUID()}`,
    object: "response",
    created_at: createdAt,
    status: params.status,
    model: params.model,
    output,
    output_text: outputText,
    usage: createUsage(params.usage),
    ...(params.error ? { error: params.error } : {}),
  };
}

export function createResponseStreamContext(model: string): ResponseStreamContext {
  return {
    responseId: `resp_${randomUUID()}`,
    outputItemId: `msg_${randomUUID()}`,
    model,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

export function buildResponseStreamPrelude(
  context: ResponseStreamContext,
): Array<Record<string, unknown>> {
  const response = createOpenAiResponseResource({
    id: context.responseId,
    outputItemId: context.outputItemId,
    model: context.model,
    status: "in_progress",
    createdAt: context.createdAt,
  });

  return [
    { type: "response.created", response },
    { type: "response.in_progress", response },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: createAssistantOutputItem({
        id: context.outputItemId,
        text: "",
        status: "in_progress",
      }),
    },
    {
      type: "response.content_part.added",
      item_id: context.outputItemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    },
  ];
}

export function buildResponseStreamCompletion(params: {
  context: ResponseStreamContext;
  outputText: string;
  usage?: Partial<OpenAiResponseResource["usage"]>;
}): Array<Record<string, unknown>> {
  const outputItem = createAssistantOutputItem({
    id: params.context.outputItemId,
    text: params.outputText,
    status: "completed",
  });
  const response = createOpenAiResponseResource({
    id: params.context.responseId,
    outputItemId: params.context.outputItemId,
    model: params.context.model,
    status: "completed",
    outputText: params.outputText,
    usage: params.usage,
    createdAt: params.context.createdAt,
  });

  return [
    {
      type: "response.output_text.done",
      item_id: params.context.outputItemId,
      output_index: 0,
      content_index: 0,
      text: params.outputText,
    },
    {
      type: "response.content_part.done",
      item_id: params.context.outputItemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: params.outputText },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: outputItem,
    },
    {
      type: "response.completed",
      response,
    },
  ];
}

export function buildResponseStreamFailure(params: {
  context: ResponseStreamContext;
  message: string;
  type?: string;
}): Record<string, unknown> {
  return {
    type: "response.failed",
    response: createOpenAiResponseResource({
      id: params.context.responseId,
      outputItemId: params.context.outputItemId,
      model: params.context.model,
      status: "failed",
      outputText: "",
      error: {
        message: params.message,
        type: params.type ?? "server_error",
      },
      createdAt: params.context.createdAt,
    }),
  };
}

export function buildOpenAiModelObject(model: CodexModel): Record<string, unknown> {
  return {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: "openai-codex",
    permission: [],
    default_reasoning_level: model.defaultReasoningLevel,
    supported_reasoning_levels: model.supportedReasoningLevels,
    max_reasoning_level: model.maxReasoningLevel,
    input_modalities: model.inputModalities,
    context_window: model.contextWindow,
    supports_parallel_tool_calls: model.supportsParallelToolCalls,
    supports_verbosity: model.supportsVerbosity,
    description: model.description,
    name: model.name,
  };
}

export function buildOpenAiErrorPayload(
  message: string,
  type = "invalid_request_error",
): OpenAiResponseErrorPayload {
  return {
    error: {
      message,
      type,
    },
  };
}
