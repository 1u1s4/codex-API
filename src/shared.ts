export function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function safeJson(text: string): unknown {
  const trimmed = normalizeNonEmptyString(text);
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export function toIsoOrNull(timestamp: number | null | undefined): string | null {
  if (!isFiniteNumber(timestamp)) {
    return null;
  }
  return new Date(timestamp).toISOString();
}
