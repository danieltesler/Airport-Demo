import { describe, expect, it } from "vitest";
import { DEFAULT_STATUS, orbAction, orbLevel, orbVisual, splitTranscript, statusFor, tailTranscript, type OrbPhase } from "./orbState";

const PHASES: OrbPhase[] = ["off", "starting", "listening", "thinking", "speaking", "paused"];

describe("orbVisual", () => {
  it("maps every phase to a known look, with off and starting idle", () => {
    expect(PHASES.map(orbVisual)).toEqual(["idle", "idle", "listening", "thinking", "speaking", "paused"]);
  });
});

describe("statusFor", () => {
  it("has a plain word for every phase and prefers the caller text", () => {
    for (const phase of PHASES) expect(DEFAULT_STATUS[phase].length).toBeGreaterThan(0);
    expect(statusFor("listening")).toBe("Listening");
    expect(statusFor("paused", "  Paused: no answer  ")).toBe("Paused: no answer");
    expect(statusFor("thinking", "   ")).toBe("Thinking");
  });
});

describe("orbAction", () => {
  it("interrupts while speaking, continues while paused, otherwise does nothing", () => {
    expect(orbAction("speaking")).toBe("interrupt");
    expect(orbAction("paused")).toBe("continue");
    expect(orbAction("listening")).toBeNull();
    expect(orbAction("thinking")).toBeNull();
  });

  it("lets the controller override, and continue wins over interrupt", () => {
    expect(orbAction("thinking", { canInterrupt: true })).toBe("interrupt");
    expect(orbAction("speaking", { needsContinue: true, canInterrupt: true })).toBe("continue");
    expect(orbAction("speaking", { canInterrupt: false })).toBeNull();
  });
});

describe("orbLevel", () => {
  it("clamps to 0-1 and ignores bad values", () => {
    expect(orbLevel(0.4, false)).toBe(0.4);
    expect(orbLevel(3, false)).toBe(1);
    expect(orbLevel(-1, false)).toBe(0);
    expect(orbLevel(Number.NaN, false)).toBe(0);
    expect(orbLevel(undefined, false)).toBe(0);
  });

  it("is zero when the user prefers reduced motion", () => {
    expect(orbLevel(0.9, true)).toBe(0);
  });
});

describe("transcript helpers", () => {
  it("splits said words from the newest three", () => {
    expect(splitTranscript("which new england airports look strong")).toEqual({
      said: "which new england",
      newest: "airports look strong",
    });
    expect(splitTranscript("hello there")).toEqual({ said: "", newest: "hello there" });
    expect(splitTranscript("   ")).toEqual({ said: "", newest: "" });
  });

  it("keeps only the tail of a long transcript, cut at a word", () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const tail = tailTranscript(long, 40);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(41);
    expect(tail.endsWith("word59")).toBe(true);
    expect(tail.slice(1)).not.toMatch(/^\S*\d\s*$/); // not a single clipped fragment
  });
});
