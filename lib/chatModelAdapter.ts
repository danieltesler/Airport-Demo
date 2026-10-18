import type { ChatModelAdapter, ThreadMessage } from "@assistant-ui/react";
import { scheduleAcknowledgement } from "./acknowledgement";
import { CHAT_CANCELLED, sendChat } from "./api";
import { buildSpokenText, speakableModelLine } from "./spoken";
import { getSpeechPlayer } from "./voicePlayback";
import { bumpVoiceEpoch, currentVoiceEpoch } from "./voiceSession";
import { consumeVoiceTurn } from "./voiceTurn";
import type { AssistantExtras, ChatResponse, ChatRole, ChatTurn } from "./types";

/**
 * Bridges assistant-ui's LocalRuntime to our own `POST /api/chat` backend
 * (see docs/API_CONTRACT.md). assistant-ui calls `run()` with the full thread;
 * we map it to the contract's `{ message, history }` shape, then return the
 * reply as message text and hand the non-text extras (structured table,
 * assumptions, uncertainty, meta) back via `metadata.custom` so the assistant
 * message component can render them beneath the reply.
 */
const STOPPED_TEXT = "Stopped.";

export const airportChatAdapter: ChatModelAdapter = {
  async run({ messages, abortSignal }) {
    const latestUserTurn = messages[messages.length - 1];
    const message = latestUserTurn ? readText(latestUserTurn) : "";
    const history = toHistory(messages.slice(0, -1));

    // Only an answer to a spoken question is read aloud on its own, and only that turn gets the "one moment".
    const askedByVoice = consumeVoiceTurn(message);
    // A new question makes every earlier pending answer stale. If End, a pause or a tap bumps this
    // again before the answer arrives, nothing is spoken: the answer just appears on screen.
    const epoch = bumpVoiceEpoch();
    const stillWanted = (): boolean => epoch === currentVoiceEpoch() && !abortSignal.aborted;
    const player = getSpeechPlayer();
    const acknowledgement =
      askedByVoice && player.autoSpeakAllowed
        ? scheduleAcknowledgement((phrase) => {
            if (stillWanted()) player.speak(phrase);
          })
        : null;

    const response = await sendChat(message, history, abortSignal);
    const acknowledged = acknowledgement?.stop() ?? false;

    // The user pressed Stop: end quietly. A short neutral line (not an error bubble, no Try again) is
    // the simplest thing that renders cleanly, and the runtime marks the message as cancelled itself.
    if (response.error === CHAT_CANCELLED) {
      if (acknowledged && epoch === currentVoiceEpoch()) player.cancel();
      return { content: [{ type: "text", text: STOPPED_TEXT }], metadata: { custom: { spoken: null } } };
    }

    const spoken = spokenFor(response);
    const extras: AssistantExtras = {
      structured: response.structured ?? null,
      assumptions: response.assumptions ?? null,
      uncertainty: response.uncertainty ?? null,
      meta: response.meta ?? null,
      spoken,
      shown: response.shown ?? null,
      error: response.error ?? null,
    };

    if (spoken && askedByVoice && stillWanted() && player.autoSpeakAllowed) player.speak(spoken);
    else if (acknowledged && epoch === currentVoiceEpoch()) player.cancel(); // never leave a "one moment" hanging with no answer behind it

    return {
      content: [{ type: "text", text: response.reply }],
      metadata: { custom: { ...extras } },
    };
  },
};

/**
 * The line to read aloud. The server's `spoken` is sent only after its guard checked every figure
 * and name against this turn's tool results, so it is used as is. Without one (older server, guard
 * rejected it, model skipped it) the code-built template from the table is used, then the reply.
 * Failed turns are not worth speaking: the on-screen error and Try again cover them.
 */
function spokenFor(response: ChatResponse): string | null {
  if (response.error) return null;
  const modelLine = response.spoken ? speakableModelLine(response.spoken) : null;
  return modelLine ?? buildSpokenText(response.reply, response.structured, response.uncertainty);
}

/** Flatten a message's text parts into a single string for the contract. */
function readText(message: ThreadMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

/** The "shown on screen" note the server returned with an assistant answer, if any. */
function shownNoteOf(message: ThreadMessage): string | undefined {
  const custom = message.metadata?.custom as AssistantExtras | undefined;
  return typeof custom?.shown === "string" && custom.shown ? custom.shown : undefined;
}

/** Prior turns, mapped to the contract's `{ role, content }` history shape, with each answer's `shown` note. */
function toHistory(messages: readonly ThreadMessage[]): ChatTurn[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const turn: ChatTurn = { role: message.role as ChatRole, content: readText(message) };
      const shown = message.role === "assistant" ? shownNoteOf(message) : undefined;
      return shown ? { ...turn, shown } : turn;
    });
}
