import { describe, expect, it } from "vitest";
import { isGhostTranscript, wordCount } from "./transcript";

describe("isGhostTranscript", () => {
  it.each(["", "   ", "Thank you.", "thank you", "You", "Bye!", "Okay.", "Hmm...", "Thanks for watching!"])("%j is a ghost", (text) => {
    expect(isGhostTranscript(text)).toBe(true);
  });

  it.each(["Which airports in the Northeast are best?", "Compare Boston and Newark", "Boston"])("%j is a question", (text) => {
    expect(isGhostTranscript(text)).toBe(false);
  });

  it("can require a minimum number of words for hands-free mode", () => {
    expect(isGhostTranscript("Boston", 2)).toBe(true);
    expect(isGhostTranscript("Boston please", 2)).toBe(false);
  });

  it("does not treat a real sentence that contains 'thank you' as filler", () => {
    expect(isGhostTranscript("Thank you, now compare Boston and Newark")).toBe(false);
  });
});

describe("wordCount", () => {
  it("ignores punctuation and counts words", () => {
    expect(wordCount("Hello, world!")).toBe(2);
    expect(wordCount("...")).toBe(0);
  });
});
