/**
 * Reads the model's final message. In SPOKEN_MODE=model it is asked for strict JSON
 * {reply, spoken}; anything else (plain text, broken JSON, wrong field types) degrades to
 * "the text is the reply, there is no spoken line". Never throws.
 */

export interface ParsedModelReply {
  reply: string;
  /** The model's spoken line, or null when absent or malformed. Unverified: the guard decides. */
  spoken: string | null;
  /** True when the message was valid {reply, spoken} JSON. */
  structured: boolean;
}

export function parseModelReply(content: string): ParsedModelReply {
  const text = content.trim();
  if (text.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === "object") {
        const { reply, spoken } = value as Record<string, unknown>;
        if (typeof reply === "string" && reply.trim()) {
          const line = typeof spoken === "string" ? spoken.trim() : "";
          return { reply: reply.trim(), spoken: line || null, structured: true };
        }
      }
    } catch {
      // fall through: plain text
    }
  }
  return { reply: text, spoken: null, structured: false };
}
