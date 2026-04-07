export function splitSseFrames(buffer: string): { frames: string[]; remaining: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames: string[] = [];
  let cursor = 0;
  let separatorIndex = normalized.indexOf("\n\n", cursor);
  while (separatorIndex !== -1) {
    frames.push(normalized.slice(cursor, separatorIndex));
    cursor = separatorIndex + 2;
    separatorIndex = normalized.indexOf("\n\n", cursor);
  }
  return {
    frames,
    remaining: normalized.slice(cursor),
  };
}

export async function* parseJsonSse(
  response: Response,
): AsyncGenerator<Record<string, unknown>, void, void> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parsed = splitSseFrames(buffer);
      buffer = parsed.remaining;

      for (const frame of parsed.frames) {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();

        if (!data || data === "[DONE]") {
          continue;
        }

        try {
          const parsedEvent = JSON.parse(data);
          if (parsedEvent && typeof parsedEvent === "object") {
            yield parsedEvent as Record<string, unknown>;
          }
        } catch {
          // Ignore malformed fragments.
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation failures during shutdown.
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore release failures during shutdown.
    }
  }
}
