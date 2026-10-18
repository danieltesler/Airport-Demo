import { describe, expect, it } from "vitest";
import geography from "../data/geography.json";
import * as data from "./data";
import { createScopeResolver, describeCoverage } from "./geography";
import { compareAirports, rankAirports } from "./tools";
import { airportSearch } from "./routeTools";
import { resolveToolScope } from "./toolScope";

const codes = (words: string): string[] => data.resolveAirportScope(words).airports.map((a) => a.iata).sort();
const statesOf = (words: string): string[] => [...new Set(data.resolveAirportScope(words).airports.map((a) => a.state))].sort();
const sets = geography.state_set_aliases as { names: string[]; label: string; states: string[]; note: string; contested: boolean }[];

describe("informal regions are named state-set aliases with a stated definition", () => {
  const lookup = (label: string) => sets.find((s) => s.label === label)!;

  it("West Coast is CA, OR and WA", () => {
    const resolution = data.resolveAirportScope("the West Coast");
    expect(resolution.status).toBe("matched");
    expect(resolution.resolvedAs).toBe("informal_region");
    expect(resolution.label).toBe("West Coast");
    expect(statesOf("West Coast")).toEqual(["CA", "OR", "WA"]);
    expect(codes("West Coast")).toEqual(expect.arrayContaining(["LAX", "SFO", "SEA", "PDX", "SAN"]));
    expect(codes("West Coast")).not.toContain("LAS");
    expect(resolution.notes[0]).toMatch(/West Coast = California, Oregon and Washington/);
    expect(resolution.detail).toBe("CA, OR, WA");
  });

  it("matches each region's data definition exactly", () => {
    for (const set of sets) {
      const expected = new Set(set.states);
      const found = data.resolveAirportScope(set.label);
      expect(found.status, set.label).toBe("matched");
      expect(found.airports.every((a) => expected.has(a.state)), set.label).toBe(true);
      expect(found.airports.length, set.label).toBe(data.allAirports().filter((a) => expected.has(a.state)).length);
      expect(found.notes[0], set.label).toBe(set.note);
      expect(found.detail, set.label).toBe(set.states.join(", "));
    }
  });

  it("East Coast is the Atlantic coastline states plus DC, not Pennsylvania", () => {
    expect(lookup("East Coast").states).toEqual(["ME", "NH", "MA", "RI", "CT", "NY", "NJ", "DE", "MD", "VA", "NC", "SC", "GA", "FL", "DC"]);
    expect(codes("East Coast")).toEqual(expect.arrayContaining(["BOS", "JFK", "DCA", "MIA", "ATL", "CLT"]));
    expect(codes("East Coast")).not.toContain("PHL");
    expect(codes("East Coast")).not.toContain("PIT");
  });

  it("Gulf Coast is TX, LA, MS, AL and FL; Pacific Northwest is WA and OR (Idaho said to be excluded)", () => {
    // Mississippi is in the definition but has no airport in the dataset; the notes say so.
    expect(statesOf("Gulf Coast")).toEqual(["AL", "FL", "LA", "TX"]);
    expect(data.resolveAirportScope("Gulf Coast").notes.join(" ")).toMatch(/No airports in the dataset for: MS/);
    expect(statesOf("Pacific Northwest")).toEqual(["OR", "WA"]);
    expect(data.resolveAirportScope("Pacific Northwest").notes[0]).toMatch(/Idaho is sometimes included and is not here/);
  });

  it("contested names resolve but say the definition varies and which states were used", () => {
    for (const name of ["Southwest", "Sun Belt", "Mid-Atlantic", "Southeast", "Deep South", "Rocky Mountain states"]) {
      const resolution = data.resolveAirportScope(name);
      expect(resolution.status, name).toBe("matched");
      expect(resolution.notes.join(" "), name).toMatch(/definitions vary/);
    }
    expect(statesOf("Southwest")).toEqual(["AZ", "NM"]);
    expect(data.resolveAirportScope("Southwest").notes.join(" ")).toMatch(/Nevada, Texas, Oklahoma, Utah, Colorado and California are sometimes added/);
    expect(statesOf("Mid-Atlantic")).toEqual(expect.arrayContaining(["NY", "NJ", "PA", "MD", "DC"]));
    expect(data.resolveAirportScope("Mid-Atlantic").notes.join(" ")).toMatch(/Middle Atlantic.*only NY, NJ and PA/);
    expect(data.resolveAirportScope("Sun Belt").notes.join(" ")).toMatch(/no official boundary/);
  });

  it("keeps the Census names as they were", () => {
    expect(data.resolveAirportScope("Midwest").resolvedAs).toBe("census_region");
    expect(data.resolveAirportScope("Northeast").resolvedAs).toBe("census_region");
    expect(data.resolveAirportScope("New England").resolvedAs).toBe("census_division");
    expect(data.resolveAirportScope("Middle Atlantic").resolvedAs).toBe("census_division");
    expect(codes("Middle Atlantic")).toEqual(expect.arrayContaining(["EWR", "PHL", "PIT"]));
    expect(data.resolveAirportScope("the South").resolvedAs).toBe("census_region");
    expect(data.resolveAirportScope("Great Lakes").resolvedAs).toBe("informal_region");
  });

  it("adds Tri-State to the NYC metro alias and keeps NYC and Bay Area as they were", () => {
    expect(codes("Tri-State")).toEqual(["EWR", "HPN", "JFK", "LGA"]);
    expect(codes("Tri-State Area")).toEqual(codes("NYC"));
    expect(codes("Bay Area")).toEqual(["OAK", "SFO", "SJC"]);
  });

  it("still asks about a contested place name (Portland, New York) instead of resolving silently", () => {
    expect(data.resolveAirportScope("Portland").status).toBe("ambiguous");
    expect(data.resolveAirportScope("New York").status).toBe("ambiguous");
  });
});

describe("the caption says how it was read", () => {
  it("shows the informal region and its states", () => {
    const out = rankAirports("West Coast", "expansion", 5, "the West Coast");
    expect(out.structured?.caption).toMatch(/^Scope: West Coast · informal region \(CA, OR, WA\) · \d+ airports matched · top 5 by expansion score$/);
    expect((out.result.scope_notes as string[])[0]).toMatch(/West Coast = California, Oregon and Washington/);
  });

  it("is used in comparisons and airport search too", async () => {
    const compare = compareAirports([], "congestion", "Gulf Coast", "Gulf Coast");
    expect(compare.structured?.caption).toMatch(/^Comparing 8 airports in Gulf Coast \(informal region: TX, LA, MS, AL, FL\), the busiest of \d+ · congestion score$/);
    const search = await airportSearch({ user_words: "Pacific Northwest" });
    expect(search.structured?.caption).toContain("Pacific Northwest · informal region (WA, OR)");
  });
});

describe("unknown areas get close, plain suggestions", () => {
  const suggestions = (words: string): string[] => data.resolveAirportScope(words).suggestions ?? [];

  it("offers the closest areas by shared words and spelling", () => {
    expect(suggestions("Pacific shore")).toEqual(expect.arrayContaining(["Pacific", "Pacific Northwest"]));
    expect(suggestions("Gulf")).toContain("Gulf Coast");
    expect(suggestions("Bay")).toContain("Bay Area");
    expect(suggestions("Gulf of Mexico coast")).toContain("Gulf Coast");
    expect(suggestions("Rocky")).toEqual(expect.arrayContaining(["Rocky Mountain states"]));
    expect(suggestions("West Coastt")).toContain("West Coast");
    expect(suggestions("Pasific Northwest").length).toBeGreaterThan(0);
  });

  it("resolves the phrasings people actually use instead of refusing them", () => {
    expect(data.resolveAirportScope("Pacific coast").label).toBe("West Coast");
    expect(data.resolveAirportScope("Atlantic coast").label).toBe("East Coast");
    expect(data.resolveAirportScope("the south").status).toBe("matched");
    const chicago = data.resolveAirportScope("Chicago area");
    expect(chicago.status).toBe("matched");
    expect(chicago.airports.map((a) => a.iata)).toEqual(expect.arrayContaining(["ORD", "MDW"]));
  });

  it("an unknown word is still unknown, with suggestions where something is close", () => {
    const resolution = data.resolveAirportScope("Narnia");
    expect(resolution.status).toBe("unknown");
    expect(resolution.airports).toEqual([]);
    expect(data.resolveAirportScope("Gulf").status).toBe("unknown");
  });

  it("the tool result carries plain wording for the model, without the words scope or recognized", () => {
    const out = rankAirports("Gulf", "expansion", 3, "Gulf");
    expect(out.result.status).toBe("unknown");
    expect(String(out.result.error)).toBe("I don't have 'Gulf' as a ready-made area.");
    expect(String(out.result.suggested_reply)).toMatch(/^I don't have 'Gulf' as a ready-made area. Did you mean .*Gulf Coast.*?$/);
    expect(String(out.result.reply_instruction)).toMatch(/Do not use the words 'scope' or 'recognized'/);
    expect(String(out.result.error) + String(out.result.suggested_reply)).not.toMatch(/scope|recogni[sz]ed/i);
    expect(out.result.coverage).toBeTruthy();
    expect((out.result.coverage as { informal_regions: string[] }).informal_regions).toContain("West Coast");
  });

  it("with nothing close, the suggested reply names what can be used", () => {
    const out = rankAirports("Narnia", "expansion", 3, "Narnia");
    expect(String(out.result.suggested_reply)).toMatch(/^I don't have 'Narnia' as a ready-made area\. I can use a U\.S\. state, a region such as the Northeast or the West Coast/);
  });

  it("several suggestions read as a choice", () => {
    const out = rankAirports("Pacific shore", "expansion", 3, "Pacific shore");
    expect(String(out.result.suggested_reply)).toMatch(/Did you mean .+ or .+\?$/);
  });
});

describe("a 150-airport synthetic fixture still works", () => {
  const fixture = Array.from({ length: 150 }, (_, i) => ({
    iata: `X${String(i).padStart(2, "0")}`,
    icao: `K${i}`,
    name: `Airport ${i}`,
    city: `City ${i}`,
    state: ["CA", "OR", "WA", "TX", "FL", "NY"][i % 6],
    lat: 30 + (i % 20),
    lon: -120 + (i % 40),
    annual_passengers: 1000 + i,
  }));
  const resolve = createScopeResolver(fixture);

  it("resolves informal regions over the fixture's own states", () => {
    const west = resolve("West Coast");
    expect(west.status).toBe("matched");
    expect(west.airports.every((a) => ["CA", "OR", "WA"].includes(a.state))).toBe(true);
    expect(west.airports).toHaveLength(75);
    expect(resolve("Gulf Coast").airports.every((a) => ["TX", "FL"].includes(a.state))).toBe(true);
    expect(resolve("all").airports).toHaveLength(150);
    expect(describeCoverage(fixture).informal_regions).toContain("West Coast");
  });

  it("reports member states that have no airports in the dataset", () => {
    expect(resolve("Gulf Coast").notes.join(" ")).toMatch(/No airports in the dataset for: LA, MS, AL/);
  });
});

describe("tool scope passes informal regions through", () => {
  it("resolveToolScope keeps the detail", () => {
    expect(resolveToolScope("West Coast", "the West Coast").detail).toBe("CA, OR, WA");
  });
});
