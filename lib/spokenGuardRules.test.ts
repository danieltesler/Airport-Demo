import { describe, expect, it } from "vitest";
import * as data from "./data";
import { extractNumbers, guardSpoken, type GuardInput } from "./spokenGuard";
import { rankAirports } from "./tools";

/**
 * Regression tests for the guard's numeric rules, from the code review: sign, counts and ranks,
 * years, unit-scaled and vague figures, derived claims, percent versus ratio, and lowercase names.
 * Each rule has the exact failing example from the review, a mutation test and a seeded property test.
 */

const verdict = (spoken: string, toolOutputs: unknown[], extra: Partial<GuardInput> = {}) => guardSpoken({ spoken, toolOutputs, ...extra });
const bad = (spoken: string, toolOutputs: unknown[], extra: Partial<GuardInput> = {}) => verdict(spoken, toolOutputs, extra).reasons.filter((r) => r.startsWith("number"));

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const rank = rankAirports("new_england", "expansion", 3);
type RankRow = { city: string; score: number; pax_growth_yoy_pct: number; load_factor: number; load_factor_pct: number; avg_dep_delay_min: number; annual_passengers: number };
const rows = rank.result.ranking as RankRow[];
const growing = rows.find((r) => r.pax_growth_yoy_pct > 0)!;
const shrinking = rows.find((r) => r.pax_growth_yoy_pct < 0)!;

describe("direction must agree with the sign of the fact", () => {
  it("rejects the reviewed example: 'down' a figure that is up", () => {
    const spoken = `${growing.city} leads, with passengers down ${Math.abs(growing.pax_growth_yoy_pct)} percent.`;
    expect(bad(spoken, [rank]).join()).toContain("not in the tool results");
  });

  it("accepts the right direction and rejects the flipped one, for a rise and for a fall", () => {
    const up = Math.round(growing.pax_growth_yoy_pct);
    const down = Math.round(Math.abs(shrinking.pax_growth_yoy_pct));
    expect(bad(`${growing.city}'s traffic is up about ${up} percent.`, [rank])).toEqual([]);
    expect(bad(`${growing.city}'s traffic is down about ${up} percent.`, [rank])).not.toEqual([]);
    expect(bad(`${shrinking.city}'s traffic fell about ${down} percent.`, [rank])).toEqual([]);
    expect(bad(`${shrinking.city}'s traffic grew about ${down} percent.`, [rank])).not.toEqual([]);
  });

  it.each([
    ["up 5 percent", "up"],
    ["5 percent higher", "up"],
    ["grew by 5 percent", "up"],
    ["down 5 percent", "down"],
    ["5 percent lower", "down"],
    ["it fell about 5 percent", "down"],
    ["cut by 5 percent", "down"],
    ["a drop of 5 percent", "down"],
  ])("reads the direction in %j", (text, direction) => {
    expect(extractNumbers(text)[0].direction).toBe(direction);
  });

  it("does not pick up a direction word from another clause", () => {
    expect(extractNumbers("Traffic is up, and delays average 14 minutes.").find((n) => n.value === 14)?.direction).toBeUndefined();
  });

  it("property: the correct direction passes and the opposite fails, whatever the figure", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const next = rng(seed * 31);
      const pct = Math.round((next() * 40 + 1) * 10) / 10; // 1.0 to 41.0
      const negative = next() < 0.5;
      const result = { ranking: [{ city: "Boston", pax_growth_yoy_pct: negative ? -pct : pct }] };
      const shown = Math.round(pct);
      const right = negative ? "down" : "up";
      const wrong = negative ? "up" : "down";
      expect(bad(`Boston is ${right} about ${shown} percent.`, [{ result }]), `${right} ${shown} for ${pct}`).toEqual([]);
      expect(bad(`Boston is ${wrong} about ${shown} percent.`, [{ result }]), `${wrong} ${shown} for ${pct}`).not.toEqual([]);
    }
  });
});

describe("counts, ranks and years only ground a count, a rank or a year", () => {
  const counted = { result: { airports_matched: 6, returned: 3, ranking: [{ city: "Boston" }, { city: "Providence" }, { city: "Hartford" }] } };

  it("rejects the reviewed example: a small invented figure that is only an array length or a rank", () => {
    expect(bad("Boston leads, with delays averaging six minutes.", [rank]).join()).toContain("six");
    expect(bad("Boston leads, with delays averaging three minutes.", [counted])).not.toEqual([]);
    expect(bad("Boston leads, with a score of three.", [counted])).not.toEqual([]);
  });

  it("accepts a count next to what is counted, and rejects a count of anything else", () => {
    expect(bad("There are six airports in that area.", [counted])).toEqual([]);
    expect(bad("I found 3 routes.", [{ result: { routes: [1, 2, 3] } }])).toEqual([]);
    expect(bad("There are seven airports in that area.", [counted])).not.toEqual([]);
    expect(bad("There are six minutes in that area.", [counted])).not.toEqual([]);
  });

  it("accepts a rank word within the list and rejects one beyond it", () => {
    expect(bad("The top three are Boston, Providence and Hartford.", [counted])).toEqual([]);
    expect(bad("Boston is number one.", [counted])).toEqual([]);
    expect(bad("The top seven are in New England.", [counted])).not.toEqual([]);
    expect(bad("Boston is number five.", [counted])).not.toEqual([]);
  });

  it("a year is only a year: not a measurement", () => {
    const result = { result: { years: { prior: 2024, current: 2025 }, passengers: 5 } };
    expect(bad("That is up from 2024 to 2025.", [result])).toEqual([]);
    expect(bad("Delays averaged 2025 minutes.", [result])).not.toEqual([]);
    expect(bad("Delays averaged 2023.", [result])).not.toEqual([]);
  });

  it("the rank column of a table is not a fact", () => {
    const table = { result: {}, structured: { kind: "ranking", columns: ["Rank", "Airport", "Delay"], rows: [[1, "A", 20], [2, "B", 30]] } };
    expect(bad("Delays average two minutes.", [table])).not.toEqual([]);
    expect(bad("Delays average 20 minutes.", [table])).toEqual([]);
  });

  it("property: a count said next to its noun passes only when it equals the real count", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const next = rng(seed * 17);
      const real = 1 + Math.floor(next() * 9);
      const wrong = real + 1 + Math.floor(next() * 3);
      const result = { result: { carrier_count: real } };
      expect(bad(`There are ${real} carriers.`, [result]), `${real}`).toEqual([]);
      expect(bad(`There are ${wrong} carriers.`, [result]), `${wrong} vs ${real}`).not.toEqual([]);
      expect(bad(`There are ${real} minutes.`, [result]), "right number, wrong noun").not.toEqual([]);
    }
  });
});

describe("unit-scaled, vague and spoken-decimal figures", () => {
  const traffic = { result: { passengers: 4_501_620, carriers: 14, flights: 39_275 } };

  it("rejects the reviewed examples", () => {
    expect(bad("About a dozen airlines fly there.", [traffic]).join()).toContain("dozen");
    expect(bad("It has 12k more flights than last year.", [traffic]).join()).toContain("12 k");
    expect(bad("It has four point nine million passengers.", [traffic]).join()).toContain("point nine");
  });

  it("scales k, m and bn before checking, so a correct abbreviation passes", () => {
    expect(extractNumbers("12k")[0].value).toBe(12_000);
    expect(extractNumbers("4.5m")[0].value).toBe(4_500_000);
    expect(extractNumbers("2bn")[0].value).toBe(2e9);
    expect(bad("About 39k flights.", [traffic])).toEqual([]);
    expect(bad("About 4.5m passengers.", [traffic])).toEqual([]);
    expect(bad("About 45m passengers.", [traffic])).not.toEqual([]);
  });

  it("reads 'four point five million' as 4.5 million", () => {
    const [n] = extractNumbers("four point five million");
    expect(n.value).toBe(4_500_000);
    expect(bad("It has four point five million passengers.", [traffic])).toEqual([]);
  });

  it("a dozen is twelve, and only passes where twelve is true", () => {
    expect(extractNumbers("a dozen")[0].value).toBe(12);
    expect(extractNumbers("two dozen")[0].value).toBe(24);
    expect(bad("About a dozen carriers.", [{ result: { carrier_count: 12 } }])).toEqual([]);
    expect(bad("About a dozen carriers.", [{ result: { carrier_count: 14 } }])).not.toEqual([]);
  });

  it("vague quantifiers are not figures, but never a licence for one", () => {
    expect(bad("A few airlines fly there, and several are small.", [traffic])).toEqual([]);
    expect(bad("A couple of airports are close.", [traffic])).toEqual([]);
    expect(bad("A few thousand passengers.", [traffic])).not.toEqual([]);
    expect(bad("Several million passengers.", [traffic])).not.toEqual([]);
    expect(bad("A couple of thousand flights.", [traffic])).not.toEqual([]);
  });

  it("property: a scaled figure passes only at its real value", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const next = rng(seed * 13);
      const millions = 1 + Math.floor(next() * 80) / 2; // 1.0 to 40.5
      const passengers = Math.round(millions * 1e6);
      const result = { result: { annual_passengers: passengers } };
      expect(bad(`About ${millions}m passengers.`, [result]), `${millions}m`).toEqual([]);
      expect(bad(`About ${millions + 3}m passengers.`, [result]), `${millions + 3}m`).not.toEqual([]);
      expect(bad(`About ${Math.round(millions * 1000)}k passengers.`, [result]), "k form of the same value").toEqual([]);
      expect(bad(`About ${Math.round(millions * 1000) + 700}k passengers.`, [result]), "k form, wrong").not.toEqual([]);
    }
  });
});

describe("derived claims the model computed", () => {
  const result = { result: { ranking: [{ city: "Boston", late_pct: 33.3, growth_pct: 4.7 }, { city: "Phoenix", late_pct: 12 }], passengers: 5_000_000 } };

  it.each([
    "Boston's traffic is half as big as Phoenix.",
    "Boston grew three times faster than average.",
    "Boston has 2x as many flights.",
    "Boston has a third as many flights.",
    "Boston's traffic is twice Phoenix.",
    "Boston's traffic doubled.",
    "Boston's traffic tripled.",
    "Boston's traffic is up threefold.",
    "Boston has a quarter more flights.",
  ])("rejects: %s", (spoken) => {
    expect(verdict(spoken, [result]).reasons.join()).toContain("computed comparison");
  });

  it("still allows a share that a tool returned", () => {
    expect(bad("About a third of Boston's flights run late.", [result])).toEqual([]);
    expect(bad("About one in three flights run late.", [result])).toEqual([]);
    expect(bad("About half of Boston's flights run late.", [result])).not.toEqual([]);
  });

  it("does not flag ordinary uses of 'times' or 'half'", () => {
    expect(bad("At times it is busy, and sometimes slow.", [result])).toEqual([]);
    expect(verdict("Boston stands out, halfway down the list.", [result]).reasons.join()).not.toContain("computed");
  });
});

describe("percent versus ratio", () => {
  const result = { result: { ranking: [{ city: "Boston", load_factor: 0.8166, load_factor_pct: 81.7, pax_growth_yoy_pct: 4.7, avg_dep_delay_min: 18.06, score: 67.2 }] } };

  it("rejects the reviewed example: a ratio spoken as a tiny percentage", () => {
    expect(bad("Boston has a load factor of 0.9 percent.", [result]).join()).toContain("0.9");
  });

  it("a ratio fact may be spoken as a percentage, or as the ratio itself", () => {
    expect(bad("Boston's load factor is about 82 percent.", [result])).toEqual([]);
    expect(bad("Boston's load factor is 0.82.", [result])).toEqual([]);
  });

  it("a ratio is not a percentage unless the speech says percent", () => {
    expect(bad("Boston's load factor is 82.", [{ result: { load_factor: 0.8166 } }])).not.toEqual([]);
    expect(bad("Boston's load factor is 82 percent.", [{ result: { load_factor: 0.8166 } }])).toEqual([]);
  });

  it("a percent fact is not a ratio or a plain figure", () => {
    const percentOnly = { result: { growth_pct: 5.7 } };
    expect(bad("Growth is 5.7 percent.", [percentOnly])).toEqual([]);
    expect(bad("Growth is 0.057.", [percentOnly])).not.toEqual([]);
    expect(bad("Growth is 5.7 minutes.", [percentOnly])).not.toEqual([]);
  });

  it("a minute count or a score cannot be spoken as a percentage", () => {
    expect(bad("Delays are 18 percent.", [result])).not.toEqual([]);
    expect(bad("Its score is 67 percent.", [result])).not.toEqual([]);
    expect(bad("Delays average 18 minutes.", [result])).toEqual([]);
  });

  it("property: a ratio passes as a percentage only at its real value, and fails as the plain whole number", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const next = rng(seed * 23);
      const ratio = Math.round((0.2 + next() * 0.7) * 1000) / 1000;
      const percent = Math.round(ratio * 100);
      const out = { result: { load_factor: ratio } };
      expect(bad(`Load factor is ${percent} percent.`, [out]), `${percent}% of ${ratio}`).toEqual([]);
      expect(bad(`Load factor is ${percent + 5} percent.`, [out])).not.toEqual([]);
      expect(bad(`Load factor is ${percent}.`, [out]), "plain whole number").not.toEqual([]);
      expect(bad(`Load factor is ${ratio}.`, [out]), "the ratio itself").toEqual([]);
    }
  });
});

describe("names, including lowercase, against the dataset's names", () => {
  const knownNames = data.allAirports().flatMap((a) => [a.city, a.name]);
  const names = (extra: Partial<GuardInput> = {}) => ({ knownNames, ...extra });

  it("rejects the reviewed example: lowercase names of airports that are not in the answer", () => {
    const spoken = `${rows[0].city} leads, ahead of phoenix and denver.`;
    const reasons = verdict(spoken, [rank], names()).reasons.join();
    expect(reasons).toContain("Phoenix");
    expect(reasons).toContain("Denver");
  });

  it("rejects the capitalised and the shouting form too", () => {
    expect(verdict(`${rows[0].city} leads, ahead of Phoenix.`, [rank], names()).ok).toBe(false);
    expect(verdict(`${rows[0].city} leads, ahead of PHOENIX.`, [rank], names()).ok).toBe(false);
  });

  it("accepts a name that is in this turn's results, in any case, and one the user said", () => {
    expect(verdict(`${rows[0].city.toLowerCase()} leads.`, [rank], names()).reasons).toEqual([]);
    expect(verdict("phoenix is next.", [rank], names({ userWords: "what about phoenix?" })).reasons).toEqual([]);
  });

  it("a known city or airport name that is not in the answer fails, whichever way it is written", () => {
    for (const airport of data.allAirports().slice(0, 40)) {
      const inAnswer = JSON.stringify(rank.result).toLowerCase().includes(airport.city.toLowerCase());
      if (inAnswer) continue;
      const result = verdict(`${rows[0].city} leads, ahead of ${airport.city.toLowerCase()}.`, [rank], names());
      expect(result.ok, airport.city).toBe(false);
    }
  });

  it("works with the production call (knownNames optional): without it only capitalised names are caught", () => {
    expect(verdict("Boston leads, ahead of Phoenix.", [rank]).ok).toBe(false);
    expect(() => guardSpoken({ spoken: "Boston leads.", toolOutputs: [rank] })).not.toThrow();
  });
});

describe("the guard stays quick with a huge conversation", () => {
  it("bounds how much context it reads", () => {
    const started = Date.now();
    verdict("Sure, it is fine.", [rank], { userWords: ("1,2 " + "a".repeat(50) + " ").repeat(3000), priorContext: "x".repeat(150_000) });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("a count only grounds the thing it counts", () => {
  const result = { result: { airports_matched: 12, ranking: [{ city: "Boston" }] } };

  it("rejects the reviewed example: 'a dozen airlines' when twelve is a count of airports", () => {
    expect(bad("About a dozen airlines fly there.", [result]).join()).toContain("dozen");
    expect(bad("About a dozen airports match.", [result])).toEqual([]);
    expect(bad("Twelve carriers fly there.", [result])).not.toEqual([]);
  });

  it("each counting field has its own noun", () => {
    expect(bad("There are 14 runways.", [{ result: { runway_count: 14 } }])).toEqual([]);
    expect(bad("There are 14 routes.", [{ result: { runway_count: 14 } }])).not.toEqual([]);
    expect(bad("It has 9 destinations.", [{ result: { routes: Array.from({ length: 9 }, () => ({})) } }])).toEqual([]);
    expect(bad("It has 9 airlines.", [{ result: { routes: Array.from({ length: 9 }, () => ({})) } }])).not.toEqual([]);
  });
});
