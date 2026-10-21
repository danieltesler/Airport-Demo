/**
 * compare_airports must compare exactly the airports the user named, whatever mix of iatas,
 * scope and user_words the model sends, and expand only a real area.
 */

import { describe, expect, it } from "vitest";
import { compareAirports } from "./tools";

const codesOf = (out: ReturnType<typeof compareAirports>): string[] =>
  (out.result.comparison as { iata: string }[]).map((c) => c.iata).sort();

describe("compare_airports reads named airports exactly", () => {
  // The model usually omits iatas and passes the user's words in scope and/or user_words.
  const phrasings: [string, string[]][] = [
    ["LAX and SNA", ["LAX", "SNA"]],
    ["LAX vs SNA", ["LAX", "SNA"]],
    ["compare LAX and SNA congestion", ["LAX", "SNA"]],
    ["compare Los Angeles and Santa Ana", ["LAX", "SNA"]],
    ["JFK vs EWR", ["EWR", "JFK"]],
    ["compare JFK, LGA and EWR", ["EWR", "JFK", "LGA"]],
    ["ATL versus ORD", ["ATL", "ORD"]],
    ["lax & sna", ["LAX", "SNA"]],
  ];
  for (const [words, expected] of phrasings) {
    it(`'${words}' compares ${expected.join(", ")} only`, () => {
      for (const out of [
        compareAirports([], "congestion", words, words), // scope and words
        compareAirports([], "congestion", undefined, words), // user_words only
        compareAirports([], "congestion", words), // scope only
      ]) {
        expect(codesOf(out)).toEqual(expected);
        expect(out.structured?.rows).toHaveLength(expected.length);
        expect(out.structured?.caption).toBe(
          `Comparing ${expected.length} airports: ${expected.join(", ")} · congestion score`,
        );
        expect(out.result.scope_note).toContain("exactly the airports named");
      }
    });
  }

  it("still compares an area when the words name one (Bay Area), labelled in the caption", () => {
    const out = compareAirports([], "congestion", "Bay Area", "Bay Area");
    expect(codesOf(out)).toEqual(["OAK", "SFO", "SJC"]);
    expect(out.structured?.caption).toBe("Comparing 3 airports in San Francisco Bay Area (metro area) · congestion score");
  });

  it("labels a capped area comparison with how many airports it was cut from", () => {
    const out = compareAirports([], "congestion", "California", "California");
    expect(out.structured?.rows).toHaveLength(8);
    expect(out.structured?.caption).toMatch(/^Comparing 8 airports in California \(state\), the busiest of \d+ · congestion score$/);
  });

  it("says ambiguous when a named city matches several airports, never silently expanding", () => {
    const out = compareAirports([], "congestion", undefined, "New York and Chicago");
    expect(out.result).toMatchObject({ status: "ambiguous" });
    expect(String(out.result.error)).toMatch(/matches more than one airport/);
    expect((out.result.options as { scope: string }[]).map((o) => o.scope)).toEqual(expect.arrayContaining(["JFK", "LGA"]));
    expect(out.structured).toBeUndefined();
  });

  it("asks which New York instead of silently returning the state table", () => {
    for (const words of ["New York airports", "compare the New York airports", "the New York airports"]) {
      for (const out of [compareAirports([], "congestion", words, words), compareAirports([], "congestion", undefined, words)]) {
        expect(out.result).toMatchObject({ status: "ambiguous" });
        expect((out.result.options as { scope: string }[]).map((o) => o.scope)).toEqual(["NY", "NYC"]);
        expect(out.structured).toBeUndefined();
      }
    }
    // The chosen option then compares the right airports.
    expect(codesOf(compareAirports([], "congestion", "NYC", "NYC"))).toEqual(["EWR", "HPN", "JFK", "LGA"]);
    expect(codesOf(compareAirports([], "congestion", "New York state", "New York state")).sort()).toEqual(["ALB", "BUF", "HPN", "JFK", "LGA", "ROC", "SYR"]);
  });

  it("uses explicit iatas as before and says so in the caption", () => {
    const out = compareAirports(["lax", "SNA"], "congestion");
    expect(out.structured?.caption).toBe("Comparing 2 airports: LAX, SNA · congestion score");
  });

  it("an unknown airport code in the words is reported, not ignored or widened", () => {
    const out = compareAirports([], "congestion", undefined, "LAX and ZZZ");
    expect(out.structured).toBeUndefined();
    expect(out.result.error).toBeTruthy();
  });

  it("orders the table by score, highest first, with insufficient data last", () => {
    const out = compareAirports(["LAX", "SNA", "JFK"], "congestion");
    const scores = (out.result.comparison as { score: number }[]).map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(out.structured?.rows.map((r) => r[1])).toEqual(scores);
  });
});

describe("population is not in the data", () => {
  it("the airport profile offers nothing population-like to quote", async () => {
    const { airportProfile } = await import("./tools");
    const text = JSON.stringify(airportProfile("SEA").result).toLowerCase();
    expect(text).not.toMatch(/population|residents|inhabitants/);
  });
});

describe("delayed-flights wording (BTS DepDel15 means 15 minutes or more)", () => {
  it("labels the column and the model field accurately without changing the number", async () => {
    const data = await import("./data");
    const { COMPONENT_LABELS } = await import("./i18n");
    const out = compareAirports(["SNA"], "congestion");
    expect(out.structured?.columns).toContain("Delayed 15+ min");
    expect(JSON.stringify(out.structured?.columns)).not.toMatch(/>15/);
    // 0.1923 of SNA's departures: still shown as 19%, now under the accurate label.
    const index = out.structured!.columns.indexOf("Delayed 15+ min");
    expect(out.structured?.rows[0][index]).toBe(`${Math.round(data.getAirport("SNA")!.delayed_share! * 100)}%`);
    const entry = (out.result.comparison as Record<string, unknown>[])[0];
    expect(entry.pct_flights_delayed_15min_or_more).toBe(19);
    expect(entry).not.toHaveProperty("pct_flights_delayed_over_15min");
    expect(COMPONENT_LABELS.delayed_share).toBe("Flights delayed 15 min or more");
  });
});

describe("named cities are matched by city component and never dropped silently", () => {
  const codes = (out: ReturnType<typeof compareAirports>) => (out.result.options as { scope: string }[] | undefined)?.map((o) => o.scope).sort();

  it("'Dallas and Austin' asks which Dallas airport instead of comparing only DAL and AUS", () => {
    const out = compareAirports([], "congestion", undefined, "Dallas and Austin");
    expect(out.result).toMatchObject({ status: "ambiguous" });
    expect(codes(out)).toEqual(["DAL", "DFW"]);
    expect(out.structured).toBeUndefined();
  });

  it("'Washington and Baltimore' compares DCA and BWI and says Dulles (IAD) was not included", () => {
    const out = compareAirports([], "congestion", undefined, "Washington and Baltimore");
    expect(codesOf(out)).toEqual(["BWI", "DCA"]);
    expect(String(out.result.scope_note)).toMatch(/same metro area were not compared: IAD/);
  });

  it("does not add a metro note when the user named airport codes", () => {
    expect(String(compareAirports([], "congestion", undefined, "DCA and BWI").result.scope_note)).not.toMatch(/metro/);
  });

  it("'Portland, OR and Seattle' reads OR as Oregon, not as the word 'or'", () => {
    const out = compareAirports([], "congestion", undefined, "Portland, OR and Seattle");
    expect(out.result.status).toBeUndefined();
    expect(codesOf(out)).toEqual(["PDX", "SEA"]);
    expect(codesOf(compareAirports([], "congestion", undefined, "Portland, ME and Boston"))).toEqual(["BOS", "PWM"]);
  });

  it("an unqualified Portland among named cities still asks which one", () => {
    const out = compareAirports([], "congestion", undefined, "Portland and Seattle");
    expect(out.result).toMatchObject({ status: "ambiguous" });
  });

  it("a city that is only a component of the airport's city string is found (Raleigh, Fort Worth)", () => {
    expect(codesOf(compareAirports([], "congestion", undefined, "Raleigh and Boston"))).toEqual(["BOS", "RDU"]);
  });
});
