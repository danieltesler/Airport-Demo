import { describe, expect, it } from "vitest";
import { splitIntoSentences } from "./sentences";
import { splitSentences } from "./voicePlayback";

describe("splitIntoSentences", () => {
  it("splits at real boundaries", () => {
    expect(splitIntoSentences("One thing. Two things! Three things?")).toEqual(["One thing.", "Two things!", "Three things?"]);
  });

  it.each([
    "It only covers U.S. airports and nothing else.",
    "The U.K. market is bigger than the U.S. market today.",
    "Use a sensible example, e.g. Boston, for the demo.",
    "That is, i.e. the second one, the best.",
    "Dr. Smith met Mr. Jones at Mt. Hood.",
    "Acme Inc. makes it, and Foo Corp. sells it.",
    "It opens at 9 a.m. and closes at 5 p.m. today.",
    "Growth was 12.5 percent, up from 3.25 last year.",
    "See No. 5 on the list for details.",
    "John F. Kennedy airport is in New York.",
  ])("does not split inside: %s", (text) => {
    expect(splitIntoSentences(text)).toEqual([text]);
  });

  it("still splits after an abbreviation that ends a sentence when a new one starts", () => {
    expect(splitIntoSentences("We cover Boston, Chicago, etc. Next we compare them.")).toEqual([
      "We cover Boston, Chicago, etc.",
      "Next we compare them.",
    ]);
    expect(splitIntoSentences("I said no. Then I left.")).toEqual(["I said no.", "Then I left."]);
  });

  it("keeps a trailing abbreviation attached to its sentence", () => {
    expect(splitIntoSentences("Only U.S. airports are covered in the U.S.")).toEqual([
      "Only U.S. airports are covered in the U.S.",
    ]);
  });

  it("returns a single sentence when there is no terminator, and nothing for blank text", () => {
    expect(splitIntoSentences("no full stop here")).toEqual(["no full stop here"]);
    expect(splitIntoSentences("   ")).toEqual([]);
  });
});

describe("playback clip splitter shares the same boundaries", () => {
  it("does not re-split on U.S.", () => {
    const text =
      "I'm unable to provide information about airports in New Zealand, as my dataset only covers U S airports. If you have questions about specific U S airports or regions, feel free to ask!";
    expect(splitSentences(text)).toEqual([
      "I'm unable to provide information about airports in New Zealand, as my dataset only covers U S airports.",
      "If you have questions about specific U S airports or regions, feel free to ask!",
    ]);
    expect(splitSentences("Only U.S. airports are covered here, ask about those.")).toHaveLength(1);
  });
});
