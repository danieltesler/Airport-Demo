import { beforeAll, describe, expect, it } from "vitest";
import * as data from "./data";
import { airportSearch, capacityTrend, carrierShare, routeSearch } from "./routeTools";
import { collectGrounding, extractNumbers, guardSpoken, type GuardInput } from "./spokenGuard";
import { airportProfile, compareAirports, longHaulBreakdown, rankAirports, unmetDemand, type ToolOutput } from "./tools";
import { faaAirportStatus } from "./live/faaStatus";
import { weatherTool } from "./live/weather";
import { btsTrafficTool } from "./live/btsTraffic";
import { faaInfrastructureTool } from "./live/faaInfrastructure";
import { censusTool } from "./live/census";
import { fixture, makeDeps, mockFetch, resetLiveState } from "./live/testing";

const verdict = (spoken: string, toolOutputs: unknown[], extra: Partial<GuardInput> = {}) =>
  guardSpoken({ spoken, toolOutputs, ...extra });

/** Independent walker for the tests: every number anywhere in the JSON, so mutations can be made non-vacuous. */
function everyNumber(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (typeof value === "string") {
    const numeric = value.replace(/[%,+]/g, "");
    if (/^-?\d+(\.\d+)?$/.test(numeric)) out.push(Number(numeric));
  } else if (Array.isArray(value)) value.forEach((v) => everyNumber(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => everyNumber(v, out));
  return out;
}

const nearAnyFact = (value: number, facts: number[], slack: number): boolean =>
  facts.some((f) => [Math.abs(f), Math.abs(f) * 100].some((c) => Math.abs(c - value) <= slack));

describe("extractNumbers", () => {
  const values = (text: string) => extractNumbers(text).map((n) => n.value);

  it.each([
    ["about 4.5 million", [4_500_000]],
    ["12 percent", [12]],
    ["twelve percent", [12]],
    ["$1,200", [1200]],
    ["four and a half million", [4_500_000]],
    ["about five million", [5_000_000]],
    ["twenty five minutes", [25]],
    ["two hundred and five", [205]],
    ["four thousand five hundred", [4500]],
    ["half a million", [500_000]],
    ["twenty twenty five", [2025]],
    ["nineteen ninety nine", [1999]],
    ["a million", [1_000_000]],
  ])("%s", (text, expected) => {
    expect(values(text)).toEqual(expected);
  });

  it("reads shares as percentages", () => {
    expect(extractNumbers("one in five")[0]).toMatchObject({ value: 20, fraction: true });
    expect(extractNumbers("1 in 4")[0]).toMatchObject({ value: 25, fraction: true });
    expect(extractNumbers("half of them")[0]).toMatchObject({ value: 50, fraction: true });
    expect(extractNumbers("a third")[0]).toMatchObject({ value: 100 / 3, fraction: true });
    expect(extractNumbers("two thirds")[0].value).toBeCloseTo(66.67, 1);
  });

  it("ignores the article 'one', ordinals within the row count, and vague amounts", () => {
    expect(values("One moment. The second one is Boston, a couple of them.")).toEqual([]);
    expect(values("It is the first of one kind")).toEqual([]);
  });

  it("counts 'one percent' and an ordinal beyond the row count", () => {
    expect(values("one percent")).toEqual([1]);
    expect(extractNumbers("the 7th", 3).map((n) => n.value)).toEqual([7]);
    expect(extractNumbers("the seventh", 3).map((n) => n.value)).toEqual([7]);
  });

  it("gives each number its spoken precision", () => {
    expect(extractNumbers("4.5 million")[0].place).toBe(100_000);
    expect(extractNumbers("five million")[0].place).toBe(1_000_000);
    expect(extractNumbers("21 million")[0].place).toBe(1_000_000);
    expect(extractNumbers("13")[0].place).toBe(1);
    expect(extractNumbers("12.8")[0].place).toBeCloseTo(0.1);
    expect(extractNumbers("10,100")[0].place).toBe(100);
  });
});

describe("rounding at the spoken precision", () => {
  const tool = { result: { passengers: 4_501_620, growth_pct: 12.8, load_factor: 0.8166, delay_min: 18.06 } };
  const say = (spoken: string) => verdict(spoken, [tool]).ok;

  it.each([
    "Traffic is about 4.5 million passengers.",
    "Traffic is about five million passengers.",
    "That's about 13 percent growth.",
    "Growth is 12.8 percent.",
    "Load factor is around 82 percent.",
    "Load factor is about eighty two percent.",
    "Delays average 18 minutes.",
    "Delays average eighteen minutes.",
  ])("accepts: %s", (spoken) => {
    expect(verdict(spoken, [tool], { }).reasons.filter((r) => r.startsWith("number"))).toEqual([]);
  });

  it.each([
    ["about four million passengers", "rounds to five, not four"],
    ["about 4.4 million passengers", "one digit off"],
    ["about 4.6 million passengers", "one digit off"],
    ["14 percent growth", "one off"],
    ["12 percent growth", "one off"],
    ["12.7 percent growth", "last digit off"],
    ["83 percent load factor", "one off"],
    ["19 minutes of delay", "one off"],
    ["about 45 million passengers", "wrong magnitude"],
  ])("rejects: %s (%s)", (spoken) => {
    expect(say(`Traffic is ${spoken}.`)).toBe(false);
  });

  it("rejects a value that is only a derived sum or difference", () => {
    // 4,501,620 + 12.8 is not a fact, and neither is 100 - 12.8.
    expect(say("It is up about 87 percent.")).toBe(false);
  });

  it("accepts a share when a fact is within ten percent of it, and rejects one that is not", () => {
    const shares = { result: { late_pct: 22 } };
    expect(verdict("About one in five flights run late.", [shares]).ok).toBe(true);
    expect(verdict("About half of flights run late.", [shares]).ok).toBe(false);
    expect(verdict("About a third of flights run late.", [shares]).ok).toBe(false);
  });

  it("rejects 'twice' and 'doubled', which compute", () => {
    expect(verdict("Traffic doubled.", [tool]).reasons.join()).toMatch(/computed comparison/);
  });

  it("understands years", () => {
    const withYears = { result: { years: { prior: 2024, current: 2025 } } };
    expect(verdict("Seats changed between 2024 and 2025.", [withYears]).ok).toBe(true);
    expect(verdict("That was in twenty twenty five.", [withYears]).ok).toBe(true);
    expect(verdict("That was in 2023.", [withYears]).ok).toBe(false);
    expect(verdict("That was in nineteen ninety nine.", [withYears]).ok).toBe(false);
  });

  it("accepts a number the user said or an earlier turn showed", () => {
    expect(verdict("Here are the top five.", [{ result: { rows: 1 } }], { userWords: "show me the top 5" }).ok).toBe(true);
    expect(verdict("Boston's growth was about three percent.", [{ result: {} }], { priorContext: "Boston growth 3.1%" }).reasons).not.toContain(
      'number: "three" is not in the tool results',
    );
  });
});

describe("format", () => {
  const tool = { result: { city: "Boston" } };
  it.each([
    ["", "empty"],
    ["Boston **leads**.", "markdown"],
    ["Boston leads. See https://example.com.", "link"],
    ["- Boston leads.", "list marker"],
    ["1. Boston leads.", "list marker"],
    ["Boston leads ✈️.", "emoji"],
    ["Boston leads.\nBoston wins.", "line break"],
    ["Boston leads. Boston is busy. Boston is big. Boston is old.", "more than 3 sentences"],
    [`Boston leads ${"and keeps going ".repeat(25)}.`, "longer than 300"],
  ])("rejects %j (%s)", (spoken, why) => {
    const result = verdict(spoken, [tool]);
    expect(result.ok).toBe(false);
    expect(result.reasons.join()).toContain(why);
  });

  it("returns an empty string when rejected, so it cannot be spoken by mistake", () => {
    expect(verdict("Boston **leads**.", [tool]).spoken).toBe("");
  });

  it("returns the cleaned line when accepted", () => {
    expect(verdict("  Boston   leads. ", [tool])).toMatchObject({ ok: true, spoken: "Boston leads." });
  });
});

describe("names", () => {
  const tool = { result: { ranking: [{ city: "Boston", iata: "BOS" }, { city: "Providence", iata: "PVD" }], carriers: ["Southwest Airlines"] } };
  it("accepts names that are in the tool results, with possessives", () => {
    expect(verdict("Boston stands out, and Providence's case is smaller.", [tool]).ok).toBe(true);
    expect(verdict("Southwest is the main carrier.", [tool]).ok).toBe(true);
  });

  it("rejects an invented city, mid-sentence or at the start", () => {
    expect(verdict("Sure, Santa Barbara stands out.", [tool]).reasons.join()).toContain("name: Santa");
    expect(verdict("Burbank stands out.", [tool]).reasons.join()).toContain("name: Burbank");
  });

  it("rejects a real carrier that is not in the results", () => {
    expect(verdict("Delta is the main carrier.", [tool]).reasons.join()).toContain("name: Delta");
  });

  it("accepts a name the user said or an earlier turn showed", () => {
    expect(verdict("Newark is next.", [tool], { userWords: "what about Newark?" }).ok).toBe(true);
    expect(verdict("Newark is next.", [tool], { priorContext: "Rows in order: 1 EWR Newark" }).ok).toBe(true);
  });

  it("accepts spelled-out codes only when the code is in the results", () => {
    expect(verdict("It's B O S, then P V D.", [tool]).ok).toBe(true);
    expect(verdict("It's S B A.", [tool]).reasons.join()).toContain("name: SBA");
    expect(verdict("It only covers U.S. airports.", [tool]).ok).toBe(true);
  });

  it("allows acronyms, months and 'I', but not other capitalised words", () => {
    expect(verdict("The FAA feed isn't answering, so I can't say since March.", [{ result: { available: false } }]).ok).toBe(true);
  });

  it("catches a real but irrelevant dataset name when the caller passes the dataset names", () => {
    const knownNames = ["Boston", "Providence", "Los Angeles"];
    expect(verdict("Boston leads, ahead of Los Angeles.", [tool], { knownNames }).reasons.join()).toContain("Los Angeles");
  });

  it("does not take vocabulary from the dataset-wide lists in an error result", () => {
    const error = { result: { error: "x is not in the dataset.", known_airports: ["LAX", "SFO", "BOS"] } };
    expect(verdict("I can't find that, but L A X is covered.", [error]).ok).toBe(false);
  });
});

describe("hedges when a result is unavailable, thin or capped", () => {
  it("requires a hedge when a source was unavailable, and then no number may be spoken", () => {
    const down = { result: { available: false, message: "could not retrieve live data" } };
    expect(verdict("Delays at JFK are 12 minutes.", [down]).ok).toBe(false);
    expect(verdict("The FAA feed isn't answering right now.", [down]).ok).toBe(true);
    expect(verdict("Everything looks smooth at Boston.", [down]).reasons.join()).toContain("hedge missing");
  });

  it("keeps dataset figures allowed when another tool succeeded", () => {
    const outputs = [{ result: { available: false } }, { result: { delayed_pct: 22, city: "Boston" } }];
    expect(verdict("The live feed isn't answering, but last year about one in five Boston flights ran late.", outputs).ok).toBe(true);
  });

  it("requires a hedge for insufficient data", () => {
    const thin = { result: { rows: [{ city: "Dothan", score: null }], note: "insufficient data" }, structured: { rows: [["Dothan", "insufficient data"]] } };
    expect(verdict("Dothan scores well.", [thin]).reasons.join()).toContain("insufficient");
    expect(verdict("Dothan doesn't have enough flights to score fairly.", [thin]).ok).toBe(true);
  });

  it("requires a hedge for a capped result and for no nonstop service", () => {
    const capped = { result: { truncated: true, routes: [{ destination_name: "Las Vegas" }] } };
    expect(verdict("Las Vegas is the biggest route.", [capped]).ok).toBe(true);
    expect(verdict("Las Vegas sells.", [capped]).ok).toBe(false);
    const none = { result: { no_service: true, message: "No nonstop service in this data" } };
    expect(verdict("There's no nonstop service in my data.", [none]).ok).toBe(true);
    expect(verdict("They link up easily.", [none]).ok).toBe(false);
  });

  it("requires a question for an ambiguous place, and no numbers", () => {
    const ambiguous = { result: { error: "Scope 'Portland' is ambiguous.", status: "ambiguous", options: [{ label: "Portland, Oregon", scope: "OR" }, { label: "Portland, Maine", scope: "ME" }] } };
    expect(verdict("Which Portland, Oregon or Maine?", [ambiguous]).ok).toBe(true);
    expect(verdict("Portland is in Oregon.", [ambiguous]).ok).toBe(false);
    expect(verdict("Which of the 2 Portlands?", [ambiguous]).ok).toBe(false);
  });
});

describe("turns with no tool", () => {
  it("fails on any number the user did not say", () => {
    expect(verdict("I cover 102 airports.", []).ok).toBe(false);
    expect(verdict("I can rank airports, compare them, and look at routes.", []).ok).toBe(true);
    expect(verdict("I can show the top 5.", [], { userWords: "show me the top 5" }).ok).toBe(true);
  });

  it("accepts an app-wide fact the caller declares", () => {
    expect(verdict("I cover 102 airports.", [], { staticFacts: [102] }).ok).toBe(true);
  });

  it("still checks names", () => {
    expect(verdict("I can look up Burbank for you.", []).ok).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// Property-style tests (seeded, so a failure is reproducible)
// --------------------------------------------------------------------------- //

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const CITIES = ["Boston", "Providence", "Hartford", "Burlington", "Portland", "Manchester"];
const WORD = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

function randomResult(next: () => number) {
  const airports = CITIES.slice(0, 3 + Math.floor(next() * 3)).map((city) => ({
    city,
    score: Math.round(next() * 1000) / 10,
    delay_min: Math.round(next() * 4000) / 100,
    passengers: Math.round(next() * 30_000_000),
    growth_pct: Math.round((next() * 20 - 5) * 10) / 10,
    load_factor: Math.round(next() * 1000) / 1000,
  }));
  return { ranking: airports };
}

/** Render a fact as a person might say it, at a precision that still rounds back to it. */
function render(fact: number, next: () => number): { text: string; value: number; place: number } {
  const big = Math.abs(fact) >= 1_000_000;
  if (big) {
    const million = Math.abs(fact) / 1e6;
    const decimals = next() < 0.5 ? 0 : 1;
    const rounded = Number(million.toFixed(decimals));
    return { text: `about ${rounded} million passengers`, value: rounded * 1e6, place: 10 ** (6 - decimals) };
  }
  if (Math.abs(fact) <= 1) {
    const percent = Math.round(Math.abs(fact) * 100);
    return { text: `${percent} percent`, value: percent, place: 1 };
  }
  const rounded = Math.round(Math.abs(fact));
  const asWord = rounded <= 20 && next() < 0.5;
  return { text: `${asWord ? WORD[rounded] : rounded} minutes`, value: rounded, place: 1 };
}

describe("property: numbers taken from a result in any legal form pass", () => {
  it.each(Array.from({ length: 60 }, (_, i) => i + 1))("seed %i", (seed) => {
    const next = rng(seed);
    const result = randomResult(next);
    const airport = result.ranking[Math.floor(next() * result.ranking.length)];
    const field = (["delay_min", "passengers", "load_factor"] as const)[Math.floor(next() * 3)];
    const rendered = render(airport[field], next);
    const spoken = `${airport.city} has ${rendered.text}.`;
    const out = verdict(spoken, [{ result }]);
    expect(out.reasons, spoken).toEqual([]);
  });
});

describe("property: mutating a spoken number makes the line fail", () => {
  it.each(Array.from({ length: 60 }, (_, i) => i + 1))("seed %i", (seed) => {
    const next = rng(seed * 7919);
    const result = randomResult(next);
    const facts = everyNumber(result);
    const airport = result.ranking[Math.floor(next() * result.ranking.length)];
    const field = (["delay_min", "passengers", "load_factor"] as const)[Math.floor(next() * 3)];
    const rendered = render(airport[field], next);

    // Move the value one spoken unit away, then skip the case where another fact legitimately sits there.
    const direction = next() < 0.5 ? -1 : 1;
    const mutated = rendered.value + direction * rendered.place;
    if (mutated <= 0 || nearAnyFact(mutated, facts, rendered.place / 2 + 1e-6)) return;

    const million = rendered.text.includes("million");
    const spokenMillions = Number((mutated / 1e6).toFixed(1));
    // "19 million" is precise to a million, "19.5 million" to a tenth: judge the mutation at the precision it is spoken with.
    const mutatedPlace = million ? (Number.isInteger(spokenMillions) ? 1e6 : 1e5) : rendered.place;
    if (nearAnyFact(mutated, facts, mutatedPlace / 2 + 1e-6)) return;
    const digits = million ? `about ${spokenMillions} million passengers` : `${mutated} ${rendered.text.includes("percent") ? "percent" : "minutes"}`;
    const out = verdict(`${airport.city} has ${digits}.`, [{ result }]);
    expect(out.ok, digits).toBe(false);
  });

  it("fails when a number from a different place is swapped in (not in any fact)", () => {
    const result = { ranking: [{ city: "Boston", delay_min: 18.06 }] };
    expect(verdict("Boston averages 31 minutes of delay.", [{ result }]).ok).toBe(false);
  });
});

describe("property: an invented or swapped name fails", () => {
  it.each(["Santa Barbara", "Sacramento", "Reykjavik", "Burbank"])("%s", (invented) => {
    const result = randomResult(rng(3));
    expect(verdict(`${invented} has the busiest runway.`, [{ result }]).ok).toBe(false);
  });
});

describe("property: any number on a no-tool turn fails", () => {
  it.each(["I can rank 5 airports.", "I know about 102 airports.", "There are about two hundred of them.", "Ask me about 2025."])("%s", (spoken) => {
    expect(verdict(spoken, []).ok).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// Real tool output
// --------------------------------------------------------------------------- //

describe("against real tool outputs", () => {
  let out: Record<string, ToolOutput>;
  const noService = { current: undefined as ToolOutput | undefined };

  beforeAll(async () => {
    resetLiveState();
    const faa = mockFetch([["nasstatus.faa.gov", { body: fixture("faa-nas-status.real.xml") }]]);
    const metar = mockFetch([["aviationweather.gov", { body: fixture("metar-kjfk.real.json") }]]);
    const bts = mockFetch([["", { body: fixture("bts-t100-bos.real.json") }]]);
    const infra = mockFetch([["ntad", { body: fixture("ntad-facility-bos.real.json") }], ["", { body: fixture("ntad-runways-bos.real.json") }]]);
    out = {
      rank: rankAirports("new_england", "expansion", 3),
      compare: compareAirports(["LAX", "SFO"], "congestion"),
      haul: longHaulBreakdown("ANC"),
      unmet: unmetDemand("SFO"),
      profile: airportProfile("BOS"),
      routes: await routeSearch({ origin: "OAK" }),
      carriers: await carrierShare({ origin: "OAK" }),
      trend: await capacityTrend({ origin: "OAK" }),
      faa: await faaAirportStatus({ iata: "SAN" }, makeDeps(faa.fetchImpl)),
      weather: await weatherTool.handler({ iata: "JFK" }, makeDeps(metar.fetchImpl)),
      bts: await btsTrafficTool.handler({ iata: "BOS" }, makeDeps(bts.fetchImpl)),
      infra: await faaInfrastructureTool.handler({ iata: "BOS" }, makeDeps(infra.fetchImpl)),
      census: await censusTool.handler({ iata: "BOS" }, makeDeps(mockFetch([]).fetchImpl)),
      unknownScope: rankAirports("Narnia", "expansion", 3),
      ambiguous: rankAirports("Portland", "expansion", 3),
      unknownAirport: unmetDemand("ZZZ"),
    };
    noService.current = await routeSearch({ origin: "OAK", destination: "ANC", user_words: "does oakland fly to anchorage" }).catch(() => undefined);
  });

  const pct = (n: number) => Math.round(Math.abs(n));

  it("ranking: names and a rounded growth figure pass; a one-digit mutation fails", () => {
    const rows = (out.rank.result.ranking as { city: string; pax_growth_yoy_pct: number }[]).slice(0, 3);
    const growth = pct(rows[0].pax_growth_yoy_pct);
    const good = `In New England, ${rows[0].city} leads, then ${rows[1].city} and ${rows[2].city}. Its traffic grew about ${growth} percent.`;
    expect(verdict(good, [out.rank]).reasons).toEqual([]);
    const facts = everyNumber(out.rank);
    const wrong = [growth + 1, growth - 1, growth + 7].find((n) => n > 0 && !nearAnyFact(n, facts, 0.6))!;
    expect(verdict(good.replace(`${growth} percent`, `${wrong} percent`), [out.rank]).ok).toBe(false);
  });

  it("ranking: an airport outside the answer is rejected", () => {
    const names = data.allAirports().map((a) => a.city);
    const outside = names.find((n) => !JSON.stringify(out.rank).includes(n))!;
    const knownNames = data.allAirports().flatMap((a) => [a.city, a.name]);
    expect(verdict(`${outside} leads.`, [out.rank], { knownNames }).ok).toBe(false);
  });

  it("comparison: the winner and a rounded delay pass", () => {
    const rows = out.compare.result.comparison as { city: string; avg_dep_delay_min: number }[];
    const spoken = `${rows[0].city} comes out ahead of ${rows[1].city}, with about ${Math.round(rows[0].avg_dep_delay_min)} minutes of delay.`;
    expect(verdict(spoken, [out.compare]).reasons).toEqual([]);
  });

  it("routes: a capped table needs a 'top/biggest' framing and only named carriers and cities", () => {
    const routes = out.routes.result.routes as { destination_name: string; carriers: { name: string }[] }[];
    const first = routes[0];
    expect(verdict(`${first.destination_name} is the biggest route, led by ${first.carriers[0].name}.`, [out.routes]).reasons).toEqual([]);
    expect(verdict(`${first.destination_name} is a route, with Frontier.`, [out.routes]).ok).toBe(false);
  });

  it("carriers: a rounded share passes, a wrong one fails", () => {
    const first = (out.carriers.result.carriers as { name: string; seat_share_pct: number }[])[0];
    const share = Math.round(first.seat_share_pct);
    expect(verdict(`${first.name} has the biggest share, about ${share} percent of seats.`, [out.carriers]).reasons).toEqual([]);
    expect(verdict(`${first.name} has the biggest share, about ${share + 9} percent of seats.`, [out.carriers]).ok).toBe(false);
  });

  it("capacity trend: the rounded change and years pass; 'why' invention does not slip a number in", () => {
    const totals = out.trend.result.totals as { seats_change_pct: number };
    const spoken = `Seats fell about ${pct(totals.seats_change_pct)} percent between 2024 and 2025, and that's the biggest change I can see.`;
    expect(verdict(spoken, [out.trend]).reasons).toEqual([]);
    expect(verdict(`Seats fell about ${pct(totals.seats_change_pct) + 5} percent between 2024 and 2025.`, [out.trend]).ok).toBe(false);
  });

  it("live FAA status, weather, BTS traffic and infrastructure", () => {
    expect(verdict("The FAA is reporting a ground delay program at San Diego right now.", [out.faa], { userWords: "any delays at san diego" }).reasons).toEqual([]);
    expect(verdict("It's VFR at the airport, with wind around nine knots.", [out.weather]).reasons).toEqual([]);
    expect(verdict("It's VFR at the airport, with wind around nineteen knots.", [out.weather]).ok).toBe(false);
    expect(verdict("In the latest year of BTS data, about 21 million passengers boarded there.", [out.bts]).reasons).toEqual([]);
    expect(verdict("In the latest year of BTS data, about 12 million passengers boarded there.", [out.bts]).ok).toBe(false);
    expect(verdict("It has six runways, and the longest is about 10,100 feet.", [out.infra]).reasons).toEqual([]);
  });

  it("a live source that is not configured needs a hedge and no population number", () => {
    expect(out.census.result.available).toBe(false);
    expect(verdict("I can't give a metro population right now, it isn't set up.", [out.census]).ok).toBe(true);
    expect(verdict("The metro has about 4 million people.", [out.census]).ok).toBe(false);
    expect(verdict("Boston is a big metro.", [out.census]).ok).toBe(false);
  });

  it("refusals: unknown place, unknown airport, ambiguity", () => {
    expect(verdict("I couldn't match that place. Want to try a U.S. state?", [out.unknownScope]).reasons).toEqual([]);
    expect(verdict("Narnia is a great market with 12 airports.", [out.unknownScope]).ok).toBe(false);
    expect(verdict("I don't have that airport in my data.", [out.unknownAirport]).ok).toBe(true);
    expect(verdict("Which Portland, Oregon or Maine?", [out.ambiguous]).ok).toBe(true);
    expect(verdict("Portland, Oregon leads.", [out.ambiguous]).ok).toBe(false);
  });

  it("every real output collects grounding facts without throwing", () => {
    for (const output of Object.values(out)) {
      expect(() => collectGrounding([output])).not.toThrow();
      expect(collectGrounding([output]).words.size).toBeGreaterThan(0);
    }
  });

  it("no-service result needs the hedge (when the route tool reports it)", () => {
    const result = noService.current;
    if (!result || result.result.no_service !== true) return;
    expect(verdict("There's no nonstop service in my data.", [result]).ok).toBe(true);
    expect(verdict("They are well connected.", [result]).ok).toBe(false);
  });

  it("airport search needs place words, and its refusal is hedged", async () => {
    const refused = await airportSearch({ query: "Boston" });
    expect(verdict("I couldn't search that, can you give me a place?", [refused]).ok).toBe(true);
  });
});
