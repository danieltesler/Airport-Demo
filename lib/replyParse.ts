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

/** Shown instead of text that looks like JSON but could not be read (a cut-off or malformed model reply). */
export const UNREADABLE_REPLY = "I had trouble putting that answer together. Could you ask it again?";

const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

export function parseModelReply(content: string): ParsedModelReply {
  let text = content.trim();
  const fenced = text.match(FENCE);
  if (fenced) text = fenced[1].trim(); // JSON wrapped in a code fence
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
      // cut off by the token limit or malformed: handled below
    }
    // Never show raw JSON to the user.
    return { reply: UNREADABLE_REPLY, spoken: null, structured: false };
  }
  return { reply: text, spoken: null, structured: false };
}
