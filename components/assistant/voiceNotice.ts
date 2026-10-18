/** Chooses the one calm line shown above the composer for voice, or null when there is nothing to say. */

export interface VoiceNoticeFacts {
  insecureContext: boolean;
  startFailure: "denied" | "unsupported" | null;
  micError: string | null;
  playbackBlocked: boolean;
  tip: string | null;
}

export const NOTICE_TEXT = {
  insecure: "Voice needs a secure (https) connection. You can still type.",
  denied: "I need microphone access to talk with you. Allow it in your browser settings, then try again.",
  unsupported: "Voice conversation is not available in this browser. You can still type.",
  blocked: "Your browser paused the audio. Tap play to hear the answer.",
};

export interface VoiceNotice {
  message: string;
  tone: "info" | "error";
}

/** Most urgent first: a problem the user must fix beats a hint. */
export function voiceNotice(facts: VoiceNoticeFacts): VoiceNotice | null {
  if (facts.insecureContext) return { message: NOTICE_TEXT.insecure, tone: "error" };
  if (facts.startFailure) return { message: NOTICE_TEXT[facts.startFailure], tone: "error" };
  if (facts.micError) return { message: facts.micError, tone: "error" };
  if (facts.playbackBlocked) return { message: NOTICE_TEXT.blocked, tone: "info" };
  if (facts.tip) return { message: facts.tip, tone: "info" };
  return null;
}
