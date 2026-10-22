import type { ChatModelAdapter, ThreadMessage } from "@assistant-ui/react";
import { scheduleAcknowledgement } from "./acknowledgement";
import { CHAT_CANCELLED, sendChat } from "./api";
import { buildSpokenText, speakableModelLine } from "./spoken";
import { getSpeechPlayer } from "./voicePlayback";
import { bumpVoiceEpoch, currentVoiceEpoch } from "./voiceSession";
import { traceVoice, voiceTrace } from "./voiceTrace";
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
    voiceTrace().startTurn();
    traceVoice("turn start", askedByVoice ? "spoken question" : "typed question");
    const stillWanted = (): boolean => epoch === currentVoiceEpoch() && !abortSignal.aborted;
    const player = getSpeechPlayer();
    const acknowledgement =
      askedByVoice && player.autoSpeakAllowed
        ? scheduleAcknowledgement((phrase) => {
            if (!stillWanted()) return;
            traceVoice("ack start");
            player.speak(phrase, { kind: "ack" });
          })
        : null;

    const response = await sendChat(message, history, abortSignal);
    const acknowledged = acknowledgement?.stop() ?? false;

    // The user pressed Stop: end quietly. A short neutral line (not an error bubble, no Try again) is
    // the simplest thing that renders cleanly, and the runtime marks the message as cancelled itself.
    if (response.error === CHAT_CANCELLED) {
      if (acknowledged && epoch === currentVoiceEpoch()) player.cancel("stopped by the user");
      return { content: [{ type: "text", text: STOPPED_TEXT }], metadata: { custom: { spoken: null } } };
    }

    const spoken = spokenFor(response);
    traceVoice(
      "answer arrived",
      `source=${response.meta?.spoken_source ?? "client"}${response.meta?.spoken_guard_rejections ? ` guard rejected ${response.meta.spoken_guard_rejections} check(s)` : response.spoken ? " guard accepted" : ""}${acknowledged ? ", acknowledgement had started" : ""}`,
    );
    const extras: AssistantExtras = {
      structured: response.structured ?? null,
      assumptions: response.assumptions ?? null,
      uncertainty: response.uncertainty ?? null,
      meta: response.meta ?? null,
      spoken,
      shown: response.shown ?? null,
      sig: response.sig ?? null,
      error: response.error ?? null,
    };

    // An acknowledgement that has started is finished, not cut off: the answer is spoken right after it.
    if (spoken && askedByVoice && stillWanted() && player.autoSpeakAllowed) player.speak(spoken, { afterAck: true });
    else if (acknowledged && epoch === currentVoiceEpoch()) player.cancel("no answer to speak"); // nothing follows a "one moment", so don't leave it hanging

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

/** The server's signature of an assistant answer, if any. */
function signatureOf(message: ThreadMessage): string | undefined {
  const custom = message.metadata?.custom as AssistantExtras | undefined;
  return typeof custom?.sig === "string" && custom.sig ? custom.sig : undefined;
}

/** Prior turns, mapped to the contract's `{ role, content }` history shape, with each answer's `shown` note and signature. */
function toHistory(messages: readonly ThreadMessage[]): ChatTurn[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const turn: ChatTurn = { role: message.role as ChatRole, content: readText(message) };
      if (message.role !== "assistant") return turn;
      const shown = shownNoteOf(message);
      const sig = signatureOf(message);
      return { ...turn, ...(shown ? { shown } : {}), ...(sig ? { sig } : {}) };
    });
}
