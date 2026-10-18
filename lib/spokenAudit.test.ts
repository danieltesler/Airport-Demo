import { describe, expect, it } from "vitest";
import { splitIntoSentences } from "./sentences";
import { buildSpokenText } from "./spoken";
import { compareAirports, longHaulBreakdown, rankAirports, unmetDemand } from "./tools";

/** What a listener would call a broken read-aloud: fragments, stray letters, markup, silence. */
function expectCompleteSentences(spoken: string | null): void {
  expect(spoken).toBeTruthy();
  const text = spoken as string;
  expect(text).not.toMatch(/[*#_`|<>()[\]]|https?:|www\.|\p{Extended_Pictographic}/u);
  expect(text).not.toMatch(/,\s*,|\s{2,}|\s[,.;:!?]|\.\.|[,;:]$/);

  for (const sentence of splitIntoSentences(text)) {
    expect(sentence, "starts with a capital or a digit").toMatch(/^["'“]?[A-Z0-9]/);
    expect(sentence, "ends with punctuation").toMatch(/[.!?]$/);
    expect(sentence.replace(/[^A-Za-z]/g, "").length, "is not a stray letter or two").toBeGreaterThanOrEqual(3);
  }
}

const PROSE_REPLIES: Record<string, string> = {
  "not in the dataset (the New Zealand reply)":
    "I'm unable to provide information about airports in New Zealand, as my dataset only covers U.S. airports. If you have questions about specific U.S. airports or regions, feel free to ask!",
  "unknown airport code": "'ZZZ' is not in the dataset. Known airports: BOS, LAX, SFO.",
  "error reply": "I hit an error while analyzing that. Please try again in a moment, or rephrase your question.",
  "greeting with bold and emoji": "**Hello!** ✈️ I can help with U.S. airports, e.g., LAX or SFO.",
  "reply with a URL": "The raw data comes from the BTS. See https://www.transtats.bts.gov/ for more. It is updated monthly.",
  "markdown link": "Source: [BTS on-time data](https://www.transtats.bts.gov/) covers 2025.",
  "bulleted list": "Here is what I can do:\n- Rank airports by expansion\n- Compare two airports\n- Show the haul mix",
  "numbered list": "The top candidates are:\n1. Boston Logan\n2. Providence\n3. Hartford",
  "parentheses and decimals": "Boston (BOS) grew 5.2% YoY, with a load factor of 0.85 (a high figure).",
  "titles, dates and abbreviations": "Dr. Smith said the U.K. market opens at 9 a.m. today. It is No. 2 by size, e.g. behind the U.S.",
  "heading and paragraphs": "## Summary\n\nBoston leads the pack\n\nChicago follows closely behind.",
};

describe("read aloud with no table: every prose reply is a complete sentence set", () => {
  it.each(Object.entries(PROSE_REPLIES))("%s", (_name, reply) => {
    expectCompleteSentences(buildSpokenText(reply, null));
  });

  it("speaks the New Zealand reply in full, with 'U S' for U.S.", () => {
    expect(buildSpokenText(PROSE_REPLIES["not in the dataset (the New Zealand reply)"], null)).toBe(
      "I'm unable to provide information about airports in New Zealand, as my dataset only covers U S airports. If you have questions about specific U S airports or regions, feel free to ask!",
    );
  });

  it("drops URLs and emoji but keeps link text", () => {
    expect(buildSpokenText(PROSE_REPLIES["reply with a URL"], null)).toBe(
      "The raw data comes from the B T S. See for more. It is updated monthly.",
    );
    expect(buildSpokenText(PROSE_REPLIES["markdown link"], null)).toBe("Source: B T S on-time data covers 2025.");
    expect(buildSpokenText(PROSE_REPLIES["greeting with bold and emoji"], null)).toBe(
      "Hello! I can help with U S airports, for example, L A X or S F O.",
    );
  });

  it("gives list items their own sentences instead of running them together", () => {
    expect(buildSpokenText(PROSE_REPLIES["numbered list"], null)).toBe(
      "The top candidates are: Boston Logan. Providence. Hartford.",
    );
  });

  it("returns nothing, not a fragment, when a reply has no words", () => {
    expect(buildSpokenText("✈️ **", null)).toBeNull();
    expect(buildSpokenText("", null)).toBeNull();
  });
});

describe("read aloud with a table: summaries from the real tools are complete sentence sets", () => {
  const outputs: Array<[string, ReturnType<typeof rankAirports>]> = [
    ["ranking, New England expansion", rankAirports("new_england", "expansion", 3)],
    ["ranking, all airports congestion", rankAirports("all", "congestion", 5)],
    ["ranking, single airport scope", rankAirports("Alaska", "expansion", 3)],
    ["comparison, LAX vs SFO", compareAirports(["LAX", "SFO"], "congestion")],
    ["comparison, one airport", compareAirports(["LAX"], "expansion")],
    ["breakdown, Anchorage haul mix", longHaulBreakdown("ANC")],
    ["metric, SFO unmet demand drivers", unmetDemand("SFO")],
  ];

  it.each(outputs)("%s", (_name, out) => {
    expect(out.structured).toBeTruthy();
    expectCompleteSentences(buildSpokenText("Model prose that must not be spoken.", out.structured, out.uncertainty));
  });

  it("never lets the model's prose through when a table exists", () => {
    const out = rankAirports("new_england", "expansion", 3);
    expect(buildSpokenText("Model prose that must not be spoken.", out.structured, out.uncertainty)).not.toContain(
      "Model prose",
    );
  });
});
