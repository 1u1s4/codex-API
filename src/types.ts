export type ReasoningLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type CodexCredential = {
  access: string;
  refresh?: string;
  expires: number;
  email?: string;
  accountId?: string;
  [key: string]: unknown;
};

export type CredentialSummary = {
  email: string | null;
  accountId: string | null;
  expires: number | null;
  expiresAt: string | null;
  hasAccess: boolean;
  hasRefresh: boolean;
};

export type CodexTextContentPart = {
  type: "input_text";
  text: string;
};

export type CodexInputRole = "system" | "developer" | "user" | "assistant";

export type CodexInputMessage = {
  role: CodexInputRole;
  content: CodexTextContentPart[];
};

export type CodexModel = {
  id: string;
  name: string;
  description: string;
  defaultReasoningLevel: ReasoningLevel;
  supportedReasoningLevels: ReasoningLevel[];
  maxReasoningLevel: ReasoningLevel;
  inputModalities: string[];
  contextWindow: number;
  supportsParallelToolCalls: boolean;
  supportsVerbosity: boolean;
};

export type CodexModelCatalog = {
  source: "live" | "static";
  clientVersion: string;
  models: CodexModel[];
};

export type FetchLike = typeof fetch;

export type CodexUsageResult = {
  endpoint: string;
  status: number;
  credential: CredentialSummary | null;
  body: unknown;
};

export type CodexResponseState = {
  id: string | null;
  status: string | null;
  model: string | null;
};

export type CodexResponsesResult = {
  endpoint: string;
  model: string;
  instructions: string;
  status: number;
  credential: CredentialSummary | null;
  outputText?: string;
  responseState?: CodexResponseState | null;
  events?: unknown[];
  body?: unknown;
};
