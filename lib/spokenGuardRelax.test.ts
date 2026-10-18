import { describe, expect, it } from "vitest";
import { documentedConstants } from "./data";
import { extractNumbers, guardSpoken, type GuardInput } from "./spokenGuard";
import { compareAirports } from "./tools";

/**
 * The guard's accept rate on the real model fell to 74%. These tests pin each relaxation that was made
 * for it (comparison words are not directions, a hedged coarse figure may be one step off, a capped
 * result only has to avoid claiming completeness, documented constants are known), and, next to each,
 * the protections that must still bite.
 */

const verdict = (spoken: string, toolOutputs: unknown[], extra: Partial<GuardInput> = {}) => guardSpoken({ spoken, toolOutputs, ...extra });
const numberReasons = (spoken: string, toolOutputs: unknown[], extra: Partial<GuardInput> = {}) =>
  verdict(spoken, toolOutputs, extra).reasons.filter((reason) => reason.startsWith("number"));

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const CONSTANTS = documentedConstants();

describe("comparison words are not directions", () => {
  const lax = compareAirports(["LAX", "SFO"], "congestion"); // LAX 13.82 min average delay, SFO 14.25

  it("accepts 'fourteen' for 13.82 when 'fifteen' appears beside a 'less than' / 'more than' comparison", () => {
    const lines = [
      "Los Angeles averages about fourteen minutes of delay, less than the fifteen minute cutoff.",
      "Los Angeles averages fourteen minutes, which is less than fifteen.",
      "Flights are late when they run more than fifteen minutes, and Los Angeles averages about fourteen.",
      "Los Angeles averages about fourteen minutes, up to fifteen on a bad day.",
      "Los Angeles averages about fourteen minutes, fewer than fifteen.",
    ];
    for (const spoken of lines) expect(numberReasons(spoken, [lax], { staticFacts: CONSTANTS }), spoken).toEqual([]);
  });

  it("reads comparison words as bounds and change words as directions", () => {
    const direction = (text: string, value: number) => extractNumbers(text).find((n) => n.value === value)?.direction;
    expect(direction("more than fifteen minutes late", 15)).toBeUndefined();
    expect(direction("fourteen minutes less than the cutoff", 14)).toBeUndefined();
    expect(direction("up to fifteen minutes", 15)).toBeUndefined();
    expect(direction("fewer than 700 thousand", 700_000)).toBeUndefined();
    expect(direction("up fourteen minutes", 14)).toBe("up");
    expect(direction("down to twelve minutes", 12)).toBe("down");
    expect(direction("5 percent more than last year", 5)).toBe("up"); // after a percentage it is a relative change
    expect(direction("fell about 5 percent", 5)).toBe("down");
  });

  it("still rejects a real direction that disagrees with the sign", () => {
    const growth = { result: { ranking: [{ city: "Boston", pax_growth_yoy_pct: -4.7 }] } };
    expect(numberReasons("Boston's traffic grew about five percent.", [growth])).not.toEqual([]);
    expect(numberReasons("Boston's traffic is up about five percent.", [growth])).not.toEqual([]);
    expect(numberReasons("Boston's traffic is five percent more than last year.", [growth])).not.toEqual([]);
    expect(numberReasons("Boston's traffic fell about five percent.", [growth])).toEqual([]);
    const rising = { result: { ranking: [{ city: "Boston", pax_growth_yoy_pct: 4.7 }] } };
    expect(numberReasons("Boston's traffic is down about five percent.", [rising])).not.toEqual([]);
    expect(numberReasons("Boston's traffic is five percent lower than last year.", [rising])).not.toEqual([]);
  });

  it("a comparison word does not rescue a wrong figure", () => {
    expect(numberReasons("Los Angeles averages about eighteen minutes, less than fifteen.", [lax], { staticFacts: CONSTANTS })).not.toEqual([]);
    expect(numberReasons("Los Angeles averages about fourteen minutes, more than twenty.", [lax], { staticFacts: CONSTANTS })).not.toEqual([]);
  });
});

describe("a hedged coarse figure may be one step off; an unhedged or explicit one may not", () => {
  const traffic = { result: { passengers: 708_570, ranking: [{ city: "Denver", annual_passengers: 708_570 }] } };

  it("accepts the reviewed examples: 'about 700 thousand' for 708,570, and the 2 significant figure form", () => {
    expect(numberReasons("About 700 thousand passengers.", [traffic])).toEqual([]);
    expect(numberReasons("Around 700 thousand passengers.", [traffic])).toEqual([]);
    expect(numberReasons("Roughly 700 thousand passengers.", [traffic])).toEqual([]);
    expect(numberReasons("About 710 thousand passengers.", [traffic])).toEqual([]);
    expect(numberReasons("About 0.7 million passengers.", [traffic])).toEqual([]); // one decimal, 708,570 rounds to it
    expect(numberReasons("About 0.6 million passengers.", [traffic])).not.toEqual([]);
  });

  it("keeps exact matching strict when there is no hedge", () => {
    expect(numberReasons("It handled 700 thousand passengers.", [traffic])).not.toEqual([]);
    expect(numberReasons("It handled 710 thousand passengers.", [traffic])).toEqual([]); // the correct two significant figure form
    expect(numberReasons("It handled 709 thousand passengers.", [traffic])).toEqual([]);
    expect(numberReasons("It handled 720 thousand passengers.", [traffic])).not.toEqual([]);
  });

  it("a hedge does not license a wrong figure: too far off, or an explicit digit that is wrong", () => {
    for (const wrong of ["690 thousand", "720 thousand", "600 thousand", "800 thousand", "650 thousand", "7 million", "70 thousand"]) {
      expect(numberReasons(`About ${wrong} passengers.`, [traffic]), wrong).not.toEqual([]);
    }
    const big = { result: { passengers: 4_501_620 } };
    expect(numberReasons("About 4.5 million passengers.", [big])).toEqual([]);
    expect(numberReasons("About 4.4 million passengers.", [big])).not.toEqual([]); // not coarse: the digit is a claim
    expect(numberReasons("About 4.6 million passengers.", [big])).not.toEqual([]);
  });

  it("'nearly' and 'almost' mean just under, 'over' and 'under' are bounds that must be true", () => {
    expect(numberReasons("Nearly 700 thousand passengers.", [traffic])).not.toEqual([]); // 708,570 is over, not under
    expect(numberReasons("Almost 710 thousand passengers.", [traffic])).toEqual([]);
    const under = { result: { passengers: 690_000 } };
    expect(numberReasons("Nearly 700 thousand passengers.", [under])).toEqual([]);
    expect(numberReasons("About 700 thousand passengers.", [under])).toEqual([]);
    expect(numberReasons("Over 700 thousand passengers.", [traffic])).toEqual([]);
    expect(numberReasons("Over 700 thousand passengers.", [under])).not.toEqual([]);
    expect(numberReasons("Under 700 thousand passengers.", [under])).toEqual([]);
    expect(numberReasons("Under 700 thousand passengers.", [traffic])).not.toEqual([]);
    expect(numberReasons("Over 900 thousand passengers.", [traffic])).not.toEqual([]);
    expect(numberReasons("Over 100 thousand passengers.", [traffic])).not.toEqual([]); // true but nowhere near: not the figure
  });

  it("a coarse minute or percent figure gets a one-unit step when hedged, no more", () => {
    const delays = { result: { avg_dep_delay_min: 20.8, delayed_pct: 19.4 } };
    expect(numberReasons("About 20 minutes of delay.", [delays])).toEqual([]);
    expect(numberReasons("20 minutes of delay.", [delays])).not.toEqual([]); // 20.8 rounds to 21
    expect(numberReasons("About 30 minutes of delay.", [delays])).not.toEqual([]);
    expect(numberReasons("About 20 percent were late.", [delays])).toEqual([]);
  });

  it("never changes a sign or a direction, however it is hedged", () => {
    const fall = { result: { seats_change: -708_570 } };
    expect(numberReasons("Seats fell by about 700 thousand.", [fall])).toEqual([]);
    expect(numberReasons("Seats rose by about 700 thousand.", [fall])).not.toEqual([]);
    expect(numberReasons("Seats are up about 700 thousand.", [fall])).not.toEqual([]);
    const rise = { result: { seats_change: 708_570 } };
    expect(numberReasons("Seats fell by about 700 thousand.", [rise])).not.toEqual([]);
  });

  it("property: the two significant figure form always passes, and one step further out never does", () => {
    // Thousands: 200 to 940 thousand, spoken as "N thousand" (N a multiple of 10 at two significant figures).
    for (let seed = 1; seed <= 80; seed++) {
      const next = rng(seed * 97);
      const passengers = Math.round(200_000 + next() * 740_000);
      const result = { result: { passengers } };
      const twoSf = Math.round(passengers / 10_000) * 10_000;
      const spokenAs = (value: number) => `${Math.round(value / 1000)} thousand`;

      expect(numberReasons(`About ${spokenAs(twoSf)} passengers.`, [result]), `${passengers} as ${spokenAs(twoSf)}`).toEqual([]);
      expect(numberReasons(`About ${spokenAs(twoSf + 30_000)} passengers.`, [result]), `${passengers} as ${spokenAs(twoSf + 30_000)}`).not.toEqual([]);
      expect(numberReasons(`About ${spokenAs(twoSf - 30_000)} passengers.`, [result]), `${passengers} as ${spokenAs(twoSf - 30_000)}`).not.toEqual([]);
    }
    // Millions: 1.0 to 9.9 million, spoken as "N.N million"; skip a spoken whole million, which is the coarse form.
    for (let seed = 1; seed <= 80; seed++) {
      const next = rng(seed * 131);
      const passengers = Math.round(1_000_000 + next() * 8_900_000);
      const result = { result: { passengers } };
      const twoSf = Math.round(passengers / 100_000) * 100_000;
      const spokenAs = (value: number) => `${Number((value / 1e6).toFixed(1))} million`;

      expect(numberReasons(`About ${spokenAs(twoSf)} passengers.`, [result]), `${passengers} as ${spokenAs(twoSf)}`).toEqual([]);
      for (const wrong of [twoSf + 300_000, twoSf - 300_000]) {
        if (Number.isInteger(wrong / 1e6)) continue; // "3 million" is a one significant figure claim with its own wider rounding
        expect(numberReasons(`About ${spokenAs(wrong)} passengers.`, [result]), `${passengers} as ${spokenAs(wrong)}`).not.toEqual([]);
      }
    }
  });
});

describe("a capped result only has to avoid claiming to be complete", () => {
  const capped = {
    result: { truncated: true, row_count: 65, returned: 10, routes: [{ destination_name: "Las Vegas" }, { destination_name: "San Diego" }] },
  };

  it("accepts plain statements about the biggest few, with or without the old hedge words", () => {
    for (const spoken of [
      "Las Vegas is the biggest route, followed by San Diego.",
      "Las Vegas and San Diego lead the list.",
      "From there, Las Vegas draws the most passengers.",
      "Oakland sends most of its passengers to Las Vegas.",
      "Las Vegas comes first.",
    ]) {
      expect(verdict(spoken, [capped], { knownNames: ["Oakland"] }).reasons.filter((r) => r.includes("capped")), spoken).toEqual([]);
    }
  });

  it("rejects describing the capped list as everything", () => {
    for (const spoken of [
      "Las Vegas and San Diego are all the routes.",
      "Every destination from there is in the table.",
      "These are all of them.",
      "Las Vegas is the only route from there.",
      "San Diego is the sole destination.",
      "That is the complete list.",
      "The full picture is Las Vegas and San Diego.",
      "There are no other routes from Oakland.",
    ]) {
      expect(verdict(spoken, [capped]).reasons.join(), spoken).toContain("complete");
    }
  });

  it("does not apply the completeness rule to a result that was not capped", () => {
    const whole = { result: { routes: [{ destination_name: "Las Vegas" }] } };
    expect(verdict("Las Vegas is the only route.", [whole]).reasons.join()).not.toContain("complete");
  });

  it("the other hedges are still required: unavailable, insufficient, no nonstop service, ambiguity", () => {
    expect(verdict("Everything is fine.", [{ result: { available: false } }]).reasons.join()).toContain("hedge missing");
    expect(verdict("It scores well.", [{ result: { rows: ["insufficient data"] } }]).reasons.join()).toContain("hedge missing");
    expect(verdict("They are connected.", [{ result: { no_service: true } }]).reasons.join()).toContain("hedge missing");
    expect(verdict("It is in Oregon.", [{ result: { error: "ambiguous", status: "ambiguous" } }]).ok).toBe(false);
  });
});

describe("documented constants and the spoken forms the prompt asks for", () => {
  it("knows the constants from the dataset's own metadata (15 minutes, 102 airports, 100 busiest, 93.9 percent)", () => {
    expect(CONSTANTS).toEqual(expect.arrayContaining([15, 102, 100]));
    const none = { result: { note: "no figures" } };
    for (const spoken of [
      "A flight counts as late after fifteen minutes.",
      "I cover 102 airports.",
      "That is the 100 busiest airports.",
      "Those airports carry about 94 percent of U.S. passengers.",
      "That is 93.9 percent of enplanements.",
    ]) {
      expect(numberReasons(spoken, [none], { staticFacts: CONSTANTS }), spoken).toEqual([]);
    }
  });

  it("without the constants the same lines are rejected (they are not facts of this turn)", () => {
    const none = { result: { note: "no figures" } };
    expect(numberReasons("I cover 102 airports.", [none])).not.toEqual([]);
    expect(numberReasons("A flight counts as late after fifteen minutes.", [none])).not.toEqual([]);
  });

  it("a wrong constant is still wrong", () => {
    const none = { result: { note: "no figures" } };
    expect(numberReasons("I cover 112 airports.", [none], { staticFacts: CONSTANTS })).not.toEqual([]);
    expect(numberReasons("A flight counts as late after twenty minutes.", [none], { staticFacts: CONSTANTS })).not.toEqual([]);
  });

  it("parses 'four and a half million', 'about 4.5 million' and 'about four point five million' to the same figure", () => {
    for (const text of ["four and a half million", "about 4.5 million", "about four point five million", "4.5m"]) {
      expect(extractNumbers(text).map((n) => n.value), text).toEqual([4_500_000]);
    }
    const big = { result: { passengers: 4_501_620 } };
    for (const text of ["four and a half million", "about 4.5 million", "about four point five million"]) {
      expect(numberReasons(`It carried ${text} passengers.`, [big]), text).toEqual([]);
    }
    expect(numberReasons("It carried four and a half million passengers.", [{ result: { passengers: 3_900_000 } }])).not.toEqual([]);
    expect(numberReasons("It carried four and a half million passengers.", [{ result: { passengers: 5_200_000 } }])).not.toEqual([]);
  });

  it("two significant figure scale forms for typical magnitudes", () => {
    const result = { result: { a: 21_128_285, b: 508_798, c: 39_275 } };
    for (const spoken of ["About 21 million.", "About 21.1 million.", "About 509 thousand.", "About 510 thousand.", "About 39 thousand.", "About 39.3 thousand."]) {
      expect(numberReasons(spoken, [result]), spoken).toEqual([]);
    }
    expect(numberReasons("About 40 thousand.", [result])).toEqual([]); // 39,275: the coarse form, hedged
    for (const spoken of ["About 22 million.", "About 520 thousand.", "About 41 thousand.", "About 38 thousand.", "40 thousand."]) {
      expect(numberReasons(spoken, [result]), spoken).not.toEqual([]);
    }
  });
});

describe("the other protections are unchanged", () => {
  const rank = { result: { ranking: [{ city: "Boston", pax_growth_yoy_pct: 5.7, avg_dep_delay_min: 13.82, annual_passengers: 708_570 }] } };

  it("invented and wrong figures, wrong names and derived claims still fail", () => {
    expect(numberReasons("Boston averages about nineteen minutes of delay.", [rank])).not.toEqual([]);
    expect(numberReasons("Boston is down about six percent.", [rank])).not.toEqual([]);
    expect(verdict("Santa Barbara has about 700 thousand passengers.", [rank]).reasons.join()).toContain("Santa");
    expect(verdict("Boston grew three times faster than average.", [rank]).reasons.join()).toContain("computed");
    expect(numberReasons("A dozen carriers fly there.", [rank])).not.toEqual([]);
  });

  it("the real tools still produce lines the guard accepts (template and hedged forms)", () => {
    const lax = compareAirports(["LAX", "SFO"], "congestion");
    expect(numberReasons("San Francisco is more congested than Los Angeles, with delays averaging about 14 minutes.", [lax], { staticFacts: CONSTANTS })).toEqual([]);
  });
});

describe("cases from the real-model check (30 questions)", () => {
  const unmet = {
    result: {
      comparison: [
        { city: "San Francisco", score: 68.6 },
        { city: "San Jose", score: 12.6 },
        { city: "Oakland", score: 11.8 },
      ],
    },
  };

  it("a comparative in front of a plain figure compares levels; it is not a change ('much lower at around 13')", () => {
    expect(extractNumbers("much lower at around 13").find((n) => n.value === 13)?.direction).toBeUndefined();
    expect(extractNumbers("higher at about 68").find((n) => n.value === 68)?.direction).toBeUndefined();
    expect(
      numberReasons("San Francisco scores about 69, while San Jose and Oakland are much lower at around 13 and 12.", [unmet]),
    ).toEqual([]);
  });

  it("a comparative right after a plain figure, and any change word, still count as a direction", () => {
    const direction = (text: string, value: number) => extractNumbers(text).find((n) => n.value === value)?.direction;
    expect(direction("700 thousand fewer passengers", 700_000)).toBe("down");
    expect(direction("14 minutes less", 14)).toBe("down");
    expect(direction("down 14 minutes", 14)).toBe("down");
    expect(direction("lower by about 5 percent", 5)).toBe("down"); // a percentage keeps both positions
    const seats = { result: { seats_change: 708_570 } };
    expect(numberReasons("It has about 700 thousand fewer seats.", [seats])).not.toEqual([]);
    expect(numberReasons("It has about 700 thousand more seats.", [seats])).toEqual([]);
    const fall = { result: { seats_change: -708_570 } };
    expect(numberReasons("It has about 700 thousand fewer seats.", [fall])).toEqual([]);
    expect(numberReasons("It has about 700 thousand more seats.", [fall])).not.toEqual([]);
  });

  it("'about 68' for 68.6 is a truncation, accepted with a hedge, strict without one; a real slip is still wrong", () => {
    expect(numberReasons("It scores about 68.", [unmet])).toEqual([]);
    expect(numberReasons("It scores around 69.", [unmet])).toEqual([]);
    expect(numberReasons("It scores 68.", [unmet])).not.toEqual([]); // no hedge: exact
    expect(numberReasons("It scores about 67.", [unmet])).not.toEqual([]); // a whole step off
    expect(numberReasons("It scores about 70.", [unmet])).not.toEqual([]);
    expect(numberReasons("It scores about 18.", [unmet])).not.toEqual([]);
    // Wrong the other way (rounded up past the figure) by a whole step is also wrong.
    expect(numberReasons("It scores about 70.", [{ result: { score: 68.6 } }])).not.toEqual([]);
  });

  it("'5.5 and 4 percent': the unit belongs to both figures", () => {
    const shares = { result: { carriers: [{ name: "Southwest Airlines", departure_share_pct: 5.5 }, { name: "Endeavor Air", seat_share_pct: 4 }] } };
    expect(extractNumbers("around 5.5 and 4 percent").map((n) => [n.value, n.percent])).toEqual([[5.5, true], [4, true]]);
    expect(numberReasons("Southwest and Endeavor have around 5.5 and 4 percent.", [shares])).toEqual([]);
    // Without the shared unit a percent fact is not a plain figure.
    expect(numberReasons("Southwest and Endeavor have around 5.5 and 4 minutes.", [shares])).not.toEqual([]);
    // And each figure still has to be a real one.
    expect(numberReasons("Southwest and Endeavor have around 5.6 and 4 percent.", [shares])).not.toEqual([]);
    expect(numberReasons("Southwest and Endeavor have around 7.5 and 4 percent.", [shares])).not.toEqual([]);
  });

  it("'26 and a half million' with digits parses like the words form", () => {
    expect(extractNumbers("26 and a half million passengers")[0]).toMatchObject({ value: 26_500_000 });
    expect(extractNumbers("26 and a half million passengers").length).toBe(1); // no stray "a half" share
    const traffic = { result: { passengers: 26_471_000 } };
    expect(numberReasons("With nearly 26 and a half million passengers this year.", [traffic])).toEqual([]);
    expect(numberReasons("With 26 and a half million passengers this year.", [traffic])).toEqual([]);
    expect(numberReasons("With 25 and a half million passengers this year.", [traffic])).not.toEqual([]);
    expect(numberReasons("With 27 and a half million passengers this year.", [traffic])).not.toEqual([]);
  });

  it("the three rejected lines from the run now pass against their real tables", () => {
    const sfo = { result: { comparison: [{ city: "San Francisco", score: 68.6, load_factor: 0.823 }, { city: "San Jose", score: 12.6 }, { city: "Oakland", score: 11.8 }] } };
    expect(
      verdict("San Francisco has a high unmet demand score of about 68, while San Jose and Oakland are much lower at around 13 and 12, respectively. San Francisco also has a higher load factor.", [sfo]).reasons.filter((r) => r.startsWith("number")),
    ).toEqual([]);
    const sf = { result: { load_factor: 0.8231, annual_passengers: 26_471_000, avg_dep_delay_min: 14.25 } };
    expect(numberReasons("Flights are about 82 percent full. With nearly 26 and a half million passengers this year, delays average about 14 minutes.", [sf])).toEqual([]);
    const atl = { structured: { columns: ["Carrier", "Seat share (%)", "Departure share (%)"], rows: [["Delta Air Lines (DL)", 73.1, 68.6], ["Southwest Airlines (WN)", 5.5, 5.5], ["Frontier Airlines (F9)", 5.5, 4.2]] }, result: {} };
    expect(numberReasons("Delta leads with about 69 percent of departures, followed by Southwest and Frontier, each with around 5.5 and 4 percent.", [atl])).toEqual([]);
  });
});
