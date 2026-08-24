import type { ChatModelAdapter, ThreadMessage } from "@assistant-ui/react";
import { sendChat } from "./api";
import type { AssistantExtras, ChatRole, ChatTurn } from "./types";

/**
 * Bridges assistant-ui's LocalRuntime to our own `POST /api/chat` backend
 * (see docs/API_CONTRACT.md). assistant-ui calls `run()` with the full thread;
 * we map it to the contract's `{ message, history }` shape, then return the
 * reply as message text and hand the non-text extras (structured table,
 * assumptions, uncertainty, meta) back via `metadata.custom` so the assistant
 * message component can render them beneath the reply.
 */
export const airportChatAdapter: ChatModelAdapter = {
  async run({ messages }) {
    const latestUserTurn = messages[messages.length - 1];
    const message = latestUserTurn ? readText(latestUserTurn) : "";
    const history = toHistory(messages.slice(0, -1));

    const response = await sendChat(message, history);

    const extras: AssistantExtras = {
      structured: response.structured ?? null,
      assumptions: response.assumptions ?? null,
      uncertainty: response.uncertainty ?? null,
      meta: response.meta ?? null,
    };

    return {
      content: [{ type: "text", text: response.reply }],
      metadata: { custom: { ...extras } },
    };
  },
};

/** Flatten a message's text parts into a single string for the contract. */
function readText(message: ThreadMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

/** Prior turns, mapped to the contract's `{ role, content }` history shape. */
function toHistory(messages: readonly ThreadMessage[]): ChatTurn[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as ChatRole,
      content: readText(message),
    }));
}
