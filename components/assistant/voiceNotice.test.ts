import { describe, expect, it } from "vitest";
import { NOTICE_TEXT, voiceNotice, type VoiceNoticeFacts } from "./voiceNotice";

const quiet: VoiceNoticeFacts = { insecureContext: false, startFailure: null, micError: null, playbackBlocked: false, tip: null };

describe("voiceNotice", () => {
  it("says nothing when there is nothing to say", () => {
    expect(voiceNotice(quiet)).toBeNull();
  });

  it("explains a failed start in plain words", () => {
    expect(voiceNotice({ ...quiet, startFailure: "denied" })).toEqual({ message: NOTICE_TEXT.denied, tone: "error" });
    expect(voiceNotice({ ...quiet, startFailure: "unsupported" })?.message).toBe(NOTICE_TEXT.unsupported);
  });

  it("puts problems before hints", () => {
    expect(voiceNotice({ ...quiet, tip: "Use headphones", micError: "Mic blocked" })?.message).toBe("Mic blocked");
    expect(voiceNotice({ ...quiet, tip: "Use headphones", playbackBlocked: true })?.tone).toBe("info");
    expect(voiceNotice({ ...quiet, insecureContext: true, startFailure: "denied" })?.message).toBe(NOTICE_TEXT.insecure);
  });

  it("shows the tip when it is all there is", () => {
    expect(voiceNotice({ ...quiet, tip: "Use headphones" })).toEqual({ message: "Use headphones", tone: "info" });
  });
});
