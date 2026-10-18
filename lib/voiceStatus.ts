import { PAUSE_MESSAGE, type ConversationSnapshot } from "./conversation";
import type { PlaybackStatus } from "./voicePlayback";

/** What the voice chip shows. One state at a time, derived from facts rather than stored. */
export type VoiceState = "idle" | "listening" | "transcribing" | "thinking" | "preparing" | "speaking" | "blocked" | "paused" | "error";

export interface VoiceFacts {
  isRecording: boolean;
  isTranscribing: boolean;
  /** Microphone or transcription failure message, if any. */
  micError: string | null;
  /** The chat turn is running (the agent is working). */
  isThinking: boolean;
  playback: PlaybackStatus;
  /** Hands-free Conversation mode, when it is on. */
  conversation?: Pick<ConversationSnapshot, "phase" | "pauseReason"> | null;
}

export const VOICE_STATE_LABEL: Record<VoiceState, string> = {
  idle: "",
  listening: "Listening, go ahead",
  transcribing: "Got it…",
  thinking: "Checking the data…",
  preparing: "Preparing voice…",
  speaking: "Speaking (AI voice), tap to interrupt",
  blocked: "Tap to hear the answer",
  paused: "Paused. Tap the mic to keep talking",
  error: "Voice is off for now. The answer is on screen.",
};

/** The chip text: the fixed label, or the specific reason when Conversation mode is paused. */
export function voiceChipText(state: VoiceState, conversation?: VoiceFacts["conversation"]): string {
  if (state === "paused" && conversation?.pauseReason) return PAUSE_MESSAGE[conversation.pauseReason];
  return VOICE_STATE_LABEL[state];
}

/**
 * Derived from the live facts, so it cannot drift out of sync with the recorder,
 * the chat turn or the player. Earlier stages of a turn win over later ones, and a
 * paused Conversation wins over everything because it is waiting for the user.
 */
export function deriveVoiceState(facts: VoiceFacts): VoiceState {
  if (facts.conversation?.phase === "paused") return "paused";
  if (facts.isRecording) return "listening";
  if (facts.isTranscribing) return "transcribing";
  if (facts.micError) return "error";
  if (facts.isThinking) return "thinking";
  if (facts.playback === "blocked") return "blocked";
  // "loading" is the first clip being fetched: nothing is audible yet, so don't say "Speaking".
  if (facts.playback === "loading") return "preparing";
  if (facts.playback === "speaking") return "speaking";
  if (facts.playback === "error") return "error";
  // Between turns of a conversation (the quiet gap) it is still listening.
  if (facts.conversation?.phase === "listening" || facts.conversation?.phase === "starting") return "listening";
  return "idle";
}
