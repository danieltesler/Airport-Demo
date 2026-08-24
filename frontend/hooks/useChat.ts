"use client";

import { useCallback, useMemo, useState } from "react";
import { sendChat } from "@/lib/api";
import type { ChatTurn, TranscriptMessage } from "@/lib/types";

interface UseChatResult {
  messages: TranscriptMessage[];
  isSending: boolean;
  /** Send a user turn. No-op if empty or a request is already in flight. */
  send: (rawText: string) => Promise<void>;
  /** The most recent assistant reply text, if any (used by text-to-speech). */
  latestAssistantReply: string | null;
}

/**
 * Owns the chat transcript and the request lifecycle.
 * Business rule: `history` sent to the backend is the transcript *before* the
 * new user turn, mapped down to the contract's `{ role, content }` shape.
 */
export function useChat(): UseChatResult {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [isSending, setIsSending] = useState(false);

  const send = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text || isSending) return;

      setIsSending(true);

      // Snapshot history from current state before appending the new turn.
      const history: ChatTurn[] = messages.map(({ role, content }) => ({
        role,
        content,
      }));

      setMessages((prev) => [...prev, { role: "user", content: text }]);

      const response = await sendChat(text, history);

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: response.reply,
          structured: response.structured ?? null,
          assumptions: response.assumptions ?? null,
          uncertainty: response.uncertainty ?? null,
          meta: response.meta ?? null,
        },
      ]);

      setIsSending(false);
    },
    [messages, isSending]
  );

  const latestAssistantReply = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].content;
    }
    return null;
  }, [messages]);

  return { messages, isSending, send, latestAssistantReply };
}
