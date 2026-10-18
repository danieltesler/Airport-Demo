import { describe, expect, it } from "vitest";
import { deriveVoiceState, voiceChipText, type VoiceFacts } from "./voiceStatus";

const quiet: VoiceFacts = { isRecording: false, isTranscribing: false, micError: null, isThinking: false, playback: "idle" };

describe("deriveVoiceState", () => {
  it("is idle when nothing is happening", () => {
    expect(deriveVoiceState(quiet)).toBe("idle");
  });

  it.each([
    [{ isRecording: true }, "listening"],
    [{ isTranscribing: true }, "transcribing"],
    [{ isThinking: true }, "thinking"],
    [{ playback: "loading" }, "preparing"],
    [{ playback: "speaking" }, "speaking"],
    [{ playback: "blocked" }, "blocked"],
    [{ playback: "error" }, "error"],
    [{ micError: "Mic blocked" }, "error"],
  ] as Array<[Partial<VoiceFacts>, string]>)("%j -> %s", (facts, expected) => {
    expect(deriveVoiceState({ ...quiet, ...facts })).toBe(expected);
  });

  it("an earlier stage wins over a later one", () => {
    expect(deriveVoiceState({ ...quiet, isRecording: true, isThinking: true, playback: "speaking" })).toBe("listening");
    expect(deriveVoiceState({ ...quiet, isThinking: true, playback: "speaking" })).toBe("thinking");
  });

  it("a transcription failure shows as error, not as the previous answer's playback", () => {
    expect(deriveVoiceState({ ...quiet, micError: "x", playback: "speaking" })).toBe("error");
  });
});

describe("Conversation mode in the chip", () => {
  it("a paused conversation shows the pause reason and wins over everything", () => {
    const facts = { ...quiet, conversation: { phase: "paused", pauseReason: "silence" } } as const;
    expect(deriveVoiceState({ ...facts, isThinking: true, playback: "speaking" })).toBe("paused");
    expect(voiceChipText("paused", facts.conversation)).toBe("Paused, I didn't hear anything. Tap the mic to keep talking");
    expect(voiceChipText("paused", { phase: "paused", pauseReason: "hidden" })).toBe("Paused. Tap the mic to keep talking");
  });

  it("between turns it is still 'listening', and with the mode off nothing changes", () => {
    expect(deriveVoiceState({ ...quiet, conversation: { phase: "listening", pauseReason: null } })).toBe("listening");
    expect(deriveVoiceState({ ...quiet, conversation: { phase: "off", pauseReason: null } })).toBe("idle");
    expect(deriveVoiceState({ ...quiet, conversation: null })).toBe("idle");
  });

  it("speaking tells the user how to interrupt, and the wording follows the spec", () => {
    expect(voiceChipText("speaking")).toBe("Speaking (AI voice), tap to interrupt");
    expect(voiceChipText("listening")).toBe("Listening, go ahead");
    expect(voiceChipText("transcribing")).toBe("Got it…");
    expect(voiceChipText("thinking")).toBe("Checking the data…");
    expect(voiceChipText("error")).toBe("Voice is off for now. The answer is on screen.");
  });
});

describe("preparing versus speaking", () => {
  it("shows 'Preparing voice…' while the first clip loads, and 'Speaking' only once audio plays", () => {
    expect(deriveVoiceState({ ...quiet, playback: "loading" })).toBe("preparing");
    expect(voiceChipText("preparing")).toBe("Preparing voice…");
    expect(deriveVoiceState({ ...quiet, playback: "speaking" })).toBe("speaking");
  });

  it("a failed first clip lands in the error state with the answer on screen", () => {
    expect(deriveVoiceState({ ...quiet, playback: "error" })).toBe("error");
    expect(voiceChipText("error")).toBe("Voice is off for now. The answer is on screen.");
  });
});
