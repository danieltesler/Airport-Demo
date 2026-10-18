import { describe, expect, it } from "vitest";
import { buildSpokenText, normaliseForSpeech, speakableModelLine, toSpokenProse, toSpokenSummary } from "./spoken";
import type { StructuredResult } from "./types";

const ranking = (
  rows: StructuredResult["rows"],
  caption: string | undefined = "Scope: LA · 5 airports matched · top 3 by expansion score",
  scoreColumn = "Expansion score",
): StructuredResult => ({
  kind: "ranking",
  columns: ["Rank", "Airport", scoreColumn, "Growth YoY", "Load factor", "Avg delay (min)"],
  rows,
  caption,
});

const THREE_ROWS = [
  [1, "LAX — Los Angeles", 82.4, "4.2%", "87.0%", 14.4],
  [2, "SNA — Santa Ana", 71.6, "1.0%", "80.0%", 9],
  [3, "SFO — San Francisco", 60.1, "-1.5%", "84.0%", 12],
];

describe("normaliseForSpeech", () => {
  it("spells out three-letter codes", () => {
    expect(normaliseForSpeech("Flights from LAX and SFO")).toBe("Flights from L A X and S F O");
  });

  it("expands percent, YoY and minutes", () => {
    expect(normaliseForSpeech("Up 4.2% YoY, 14 min delay")).toBe("Up 4.2 percent year over year, 14 minutes delay");
  });

  it("speaks negatives, ranges and comparisons", () => {
    expect(normaliseForSpeech("-1.5%")).toBe("minus 1.5 percent");
    expect(normaliseForSpeech("Medium (500-1500 mi)")).toBe("Medium, 500 to 1500 miles");
    expect(normaliseForSpeech("Short (<500 mi)")).toBe("Short, under 500 miles");
    expect(normaliseForSpeech("Flights delayed >15 min")).toBe("Flights delayed over 15 minutes");
  });

  it("speaks a month label as a month, not as a range", () => {
    expect(normaliseForSpeech("Enplaned passengers (2025-05 to 2026-04)")).toBe(
      "Enplaned passengers, May 2025 to April 2026",
    );
  });

  it("leaves ordinary words and mixed-case text alone", () => {
    expect(normaliseForSpeech("Boston Logan")).toBe("Boston Logan");
    expect(normaliseForSpeech("Minimum")).toBe("Minimum");
  });

  it("sets a parenthetical off with commas and leaves no doubled or dangling commas", () => {
    expect(normaliseForSpeech("peaks (holidays, weather events) are smoothed out.")).toBe(
      "peaks, holidays, weather events, are smoothed out.",
    );
    expect(normaliseForSpeech("Congestion (delay/throughput)")).toBe("Congestion, delay throughput");
    expect(normaliseForSpeech("Answer (see below).")).toBe("Answer, see below.");
    expect(normaliseForSpeech("broken (text")).toBe("broken text");
  });
});

describe("template v2: ranking", () => {
  it("names the leader and the next two in plain words, with scope and one figure", () => {
    expect(toSpokenSummary(ranking(THREE_ROWS))).toBe(
      "In LA, Los Angeles looks strongest for expansion, with traffic up about four percent, followed by Santa Ana and San Francisco.",
    );
  });

  it("has no 'out of 100', no scores and no codes", () => {
    const spoken = toSpokenSummary(ranking(THREE_ROWS))!;
    expect(spoken).not.toMatch(/out of 100|score|\b82\b|LAX|SNA|SFO/);
  });

  it("adds the first short sentence of the uncertainty as the one caveat, and drops a long one", () => {
    const short = toSpokenSummary(ranking(THREE_ROWS), "Score reflects demand-side opportunity only. It ignores cost.")!;
    expect(short.endsWith("Score reflects demand-side opportunity only.")).toBe(true);
    const long = toSpokenSummary(ranking(THREE_ROWS), `${"A very long caveat sentence ".repeat(6)}ends here. More.`)!;
    expect(long.split(/(?<=\.)\s/)).toHaveLength(1);
  });

  it("speaks a shrinking leader as down, and skips a negligible change", () => {
    const down = toSpokenSummary(ranking([[1, "SFO — San Francisco", 60, "-1.5%", "84.0%", 12]]))!;
    expect(down).toContain("with traffic down about two percent");
    const flat = toSpokenSummary(ranking([[1, "SFO — San Francisco", 60, "0.2%", "84.0%", 12]]))!;
    expect(flat).toBe("In LA, San Francisco looks strongest for expansion.");
  });

  it("uses delay for a congestion ranking and a fitting verb for each metric", () => {
    const congestion = toSpokenSummary(ranking(THREE_ROWS, "Scope: all airports · 28 airports matched · top 3 by congestion score", "Congestion score"))!;
    expect(congestion).toBe("Across all airports, Los Angeles is the most congested, with delays averaging about 14 minutes, followed by Santa Ana and San Francisco.");
    expect(toSpokenSummary(ranking(THREE_ROWS, undefined, "Unmet-demand score"))).toContain("shows the most unmet demand");
  });

  it("leaves out an odd scope rather than reading it badly", () => {
    expect(toSpokenSummary(ranking(THREE_ROWS, "Scope: near Portland, OR · 3 airports matched"))!.startsWith("Los Angeles")).toBe(true);
    expect(toSpokenSummary({ ...ranking(THREE_ROWS), caption: undefined })!.startsWith("Los Angeles")).toBe(true);
  });

  it("tells two airports in the same city apart", () => {
    const rows = [
      [1, "JFK — New York", 70, "1.0%", "80.0%", 10],
      [2, "LGA — New York", 65, "1.0%", "80.0%", 10],
    ];
    const spoken = toSpokenSummary(ranking(rows))!;
    expect(spoken).toContain("New York J F K");
    expect(spoken).toContain("followed by New York L G A");
  });

  it("speaks hyphenated and slashed city names naturally", () => {
    const rows = [
      [1, "DFW — Dallas-Fort Worth", 70, "1.0%", "80.0%", 10],
      [2, "PVD — Providence/Warwick", 65, "1.0%", "80.0%", 10],
    ];
    const spoken = toSpokenSummary(ranking(rows))!;
    expect(spoken).toContain("Dallas Fort Worth");
    expect(spoken).toContain("Providence Warwick");
  });

  it("returns null for empty or unusable results", () => {
    expect(toSpokenSummary(null)).toBeNull();
    expect(toSpokenSummary(ranking([]))).toBeNull();
    expect(toSpokenSummary(ranking([[1, "LAX — Los Angeles", "n/a", "x", 0, 0]]))).toBeNull();
  });

  it("stays within two short sentences", () => {
    const spoken = toSpokenSummary(ranking(THREE_ROWS), "Score reflects demand-side opportunity only. It ignores cost.")!;
    expect(spoken.length).toBeLessThanOrEqual(260);
  });
});

describe("template v2: comparison, breakdown and metric tables", () => {
  const comparison = (rows: StructuredResult["rows"], scoreColumn = "Congestion score"): StructuredResult => ({
    kind: "comparison",
    columns: ["Airport", scoreColumn, "Avg delay (min)", "Delayed 15+ min", "Load factor", "Cancel rate"],
    rows,
  });

  it("names the winner whatever the row order, with its delay for congestion", () => {
    const spoken = toSpokenSummary(comparison([["SFO — San Francisco", 33.4, 14.25, "19%", "82.3%", "0.8%"], ["LAX — Los Angeles", 28.6, 13.82, "18%", "81.7%", "0.7%"]]))!;
    expect(spoken).toBe("San Francisco is more congested than Los Angeles, with delays averaging about 14 minutes.");
  });

  it("uses 'ahead of' for other metrics, calls a rounded tie level, and handles one airport", () => {
    const rows = [["AAA — Aaa", 50.4, 1, "1%", "1%", "1%"], ["BBB — Bbb", 40, 1, "1%", "1%", "1%"]];
    expect(toSpokenSummary(comparison(rows, "Expansion score"))).toBe("Aaa comes out ahead of Bbb on expansion.");
    expect(toSpokenSummary(comparison([["AAA — Aaa", 50.1, 1, "1%", "1%", "1%"], ["BBB — Bbb", 49.9, 1, "1%", "1%", "1%"]], "Expansion score"))).toBe("Aaa and Bbb are about level on expansion.");
    expect(toSpokenSummary(comparison([["AAA — Aaa", 50, 1, "1%", "1%", "1%"]], "Expansion score"))).toBe("Aaa is the only airport in that comparison.");
  });

  it("says plainly that an unscored airport can't be scored", () => {
    const rows = [["AAA — Aaa", 50, 1, "1%", "1%", "1%"], ["BBB — Bbb", "insufficient data", "n/a", "n/a", "n/a", "n/a"]];
    expect(toSpokenSummary(comparison(rows, "Expansion score"))).toBe("There isn't enough data to score Bbb fairly.");
  });

  it("speaks the haul mix by its largest share", () => {
    const breakdown: StructuredResult = {
      kind: "breakdown",
      columns: ["Haul type", "Share of departures"],
      rows: [["Short (<1100 mi)", "61.9%"], ["Medium (1100-2200 mi)", "24.9%"], ["Long (>2200 mi)", "13.2%"]],
    };
    expect(toSpokenSummary(breakdown)).toBe("Most departures are short haul, about 62 percent.");
    const even: StructuredResult = { ...breakdown, rows: [["Short (<1100 mi)", "40.0%"], ["Long (>2200 mi)", "35%"]] };
    expect(toSpokenSummary(even)).toBe("The biggest share of departures is short haul, 40 percent.");
  });

  it("speaks the top unmet-demand driver without the 0-1 numbers", () => {
    const metric: StructuredResult = {
      kind: "metric",
      columns: ["Driver", "Contribution (0-1)"],
      rows: [["Load-factor pressure", 0.931], ["Congestion (delay/throughput)", 0.334], ["Growth vs. capacity", 0.786]],
    };
    expect(toSpokenSummary(metric)).toBe("Load factor pressure is the biggest driver, followed by growth versus capacity.");
  });

  it("speaks routes, carriers, capacity trend, weather, FAA, BTS, infrastructure, census and live activity sensibly", () => {
    const metric = (columns: string[], rows: StructuredResult["rows"]): StructuredResult => ({ kind: "metric", columns, rows });
    expect(toSpokenSummary(metric(["Rank", "Destination", "Carriers", "Passengers"], [[1, "LAS — Las Vegas", "Southwest", 508798], [2, "SAN — San Diego", "x", 1], [3, "BUR — Burbank", "x", 1]])))
      .toBe("Las Vegas is the biggest route, followed by San Diego and Burbank.");
    expect(toSpokenSummary(metric(["Carrier", "Seats", "Seat share (%)"], [["Southwest Airlines (WN)", 4800473, 78.2]])))
      .toBe("Southwest Airlines has the biggest share, about 78 percent of seats.");
    expect(toSpokenSummary(metric(["Change", "Destination", "Seats 2024", "Seats 2025", "Seat change", "Seat change (%)"], [["Total", "all destinations", 7034708, 6137508, -897200, "-12.8%"], ["Cut", "LAX — Los Angeles", 1, 1, -1, "-31.7%"]])))
      .toBe("Seats fell about 13 percent between 2024 and 2025, and the biggest cut was Los Angeles. The data shows what changed, not why.");
    expect(toSpokenSummary(metric(["Weather (now)", "Value"], [["Flight category now", "VFR"], ["Wind (kt)", 9]])))
      .toBe("It's V F R right now, with wind around nine knots.");
    expect(toSpokenSummary(metric(["FAA status (now)", "Detail"], [["ground delay program", "airport volume"], ["closure", "!SAN 10/004 SAN AD AP CLSD"]])))
      .toBe("The F A A is reporting a ground delay program and a closure right now.");
    expect(toSpokenSummary(metric(["FAA status (now)", "Detail"], [["none", "No FAA ground stop"]])))
      .toContain("F A A isn't reporting any ground stop");
    expect(toSpokenSummary(metric(["BTS T-100 (live query)", "Value"], [["Enplaned passengers (2025-05 to 2026-04)", 20983745]])))
      .toBe("In the latest year of B T S data, about 21 million passengers boarded there.");
    expect(toSpokenSummary(metric(["FAA infrastructure", "Value"], [["Runways", 6], ["Longest runway (ft)", 10083], ["Acres", 33531]])))
      .toBe("It has six runways, and the longest is about 10,100 feet.");
    expect(toSpokenSummary(metric(["Census ACS 2024 (Boston)", "Value"], [["Metro population", 4_900_000]])))
      .toBe("The metro area has about 4.9 million people.");
    expect(toSpokenSummary(metric(["Live activity (now)", "Count"], [["Airborne nearby", 30], ["On the ground", 18], ["Total in area", 48]])))
      .toBe("About 48 aircraft are in the area right now, 30 of them airborne.");
  });

  it("never reads a table it does not understand as nonsense: it returns null", () => {
    const unknown: StructuredResult = { kind: "metric", columns: ["Something new", "Value"], rows: [["Visibility, sm", 10], ["Wind, kt", 7]] };
    expect(toSpokenSummary(unknown)).toBeNull();
    const mangled: StructuredResult = { kind: "metric", columns: ["Weather (now)", "Value"], rows: [["Visibility (sm)", 10]] };
    expect(toSpokenSummary(mangled)).toBeNull();
  });
});

describe("toSpokenProse and buildSpokenText", () => {
  it("strips markdown and speaks every sentence of a short reply", () => {
    expect(toSpokenProse("**Hello!** I can rank airports. I can compare them.")).toBe("Hello! I can rank airports. I can compare them.");
  });

  it("cuts long prose between sentences and points to the screen", () => {
    const sentence = `${"word ".repeat(40).trim()}.`;
    const spoken = toSpokenProse(Array(6).fill(sentence).join(" "))!;
    expect(spoken.endsWith("The rest is on screen.")).toBe(true);
    expect(spoken.replace(" The rest is on screen.", "").length).toBeLessThanOrEqual(600);
    expect(spoken.split(sentence).length - 1).toBe(2);
  });

  it("speaks an over-long single sentence whole rather than cutting it", () => {
    const long = `${"word ".repeat(200).trim()}.`;
    expect(toSpokenProse(long)).toBe(long);
  });

  it("returns null for empty prose", () => {
    expect(toSpokenProse("   ")).toBeNull();
  });

  it("prefers the structured summary and ignores the model's prose", () => {
    const spoken = buildSpokenText("The model said BOGUS 99.", ranking(THREE_ROWS))!;
    expect(spoken).not.toContain("BOGUS");
    expect(spoken).toContain("Los Angeles");
  });

  it("falls back to prose when there is no table or the table is not summarisable", () => {
    expect(buildSpokenText("Hi there. Ask me about airports.", null)).toBe("Hi there. Ask me about airports.");
    const unknown: StructuredResult = { kind: "metric", columns: ["Something new", "Value"], rows: [["x", 1]] };
    expect(buildSpokenText("Here is what I found.", unknown)).toBe("Here is what I found.");
  });
});

describe("speakableModelLine", () => {
  it("spells out codes and abbreviations and ends in punctuation", () => {
    expect(speakableModelLine("Sure, it only covers U.S. airports, like LAX")).toBe("Sure, it only covers U S airports, like L A X.");
  });

  it("returns null for blank input", () => {
    expect(speakableModelLine("  ")).toBeNull();
  });
});
