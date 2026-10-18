import { describe, expect, it } from "vitest";
import {
  censusDivisionOf,
  describeCoverage,
  haversineMiles,
  normalizeScope,
  resolveScope,
  type GeoAirport,
} from "./geography";
import * as data from "./data";
import { rankAirports } from "./tools";

const codes = (scope: string): string[] =>
  data
    .resolveAirportScope(scope)
    .airports.map((a) => a.iata)
    .sort();

describe("haversineMiles", () => {
  it("is zero for the same point and symmetric", () => {
    expect(haversineMiles(40, -70, 40, -70)).toBe(0);
    expect(haversineMiles(40.6, -73.8, 33.9, -118.4)).toBeCloseTo(haversineMiles(33.9, -118.4, 40.6, -73.8), 6);
  });

  it("matches known city-pair distances", () => {
    const jfk = data.getAirport("JFK")!;
    const lax = data.getAirport("LAX")!;
    expect(haversineMiles(jfk.lat, jfk.lon, lax.lat, lax.lon)).toBeGreaterThan(2440);
    expect(haversineMiles(jfk.lat, jfk.lon, lax.lat, lax.lon)).toBeLessThan(2510);
  });

  it("works at high latitude (Anchorage to Seattle)", () => {
    const anc = data.getAirport("ANC")!;
    const sea = data.getAirport("SEA")!;
    const miles = haversineMiles(anc.lat, anc.lon, sea.lat, sea.lon);
    expect(miles).toBeGreaterThan(1400);
    expect(miles).toBeLessThan(1500);
  });
});

describe("normalizeScope", () => {
  it("ignores case, whitespace, punctuation and a leading 'the'", () => {
    expect(normalizeScope("  The  New_England ")).toBe("new england");
    expect(normalizeScope("L.A.")).toBe("la");
    expect(normalizeScope("St. Louis")).toBe("st louis");
    expect(normalizeScope("Portland, ME")).toBe("portland me");
  });
});

describe("Census regions and divisions", () => {
  it("resolves New England by the official division, not a hand-kept list", () => {
    const resolution = data.resolveAirportScope("New England");
    expect(resolution.status).toBe("matched");
    expect(resolution.resolvedAs).toBe("census_division");
    expect(resolution.label).toBe("New England");
    expect(codes("new_england")).toEqual(["BDL", "BOS", "BTV", "MHT", "PVD", "PWM"]);
    expect(resolution.notes.join(" ")).toContain("CT, ME, MA, NH, RI, VT");
  });

  it("gives other divisions and regions for free", () => {
    expect(codes("Pacific")).toEqual(expect.arrayContaining(["LAX", "SEA", "ANC", "SFO", "HNL", "PDX"]));
    expect(codes("Pacific")).not.toContain("DEN");
    expect(codes("Mountain")).toEqual(expect.arrayContaining(["DEN", "LAS", "PHX", "SLC", "BOI"]));
    expect(codes("Mountain")).not.toContain("LAX");
    expect(codes("Middle Atlantic")).toEqual(expect.arrayContaining(["EWR", "JFK", "LGA", "PHL", "PIT"]));
    const northeast = data.resolveAirportScope("Northeast");
    expect(northeast.resolvedAs).toBe("census_region");
    expect(northeast.airports.map((a) => a.iata)).toEqual(expect.arrayContaining(["BOS", "JFK", "EWR"]));
    expect(codes("Midwest")).toEqual(expect.arrayContaining(["ORD", "MDW", "MSP", "DTW", "STL"]));
    expect(codes("Midwest")).not.toContain("ATL");
    expect(codes("south")).toEqual(expect.arrayContaining(["ATL", "MIA", "DFW", "DCA"]));
  });

  it("reports states of a division that the dataset does not cover", () => {
    const resolution = data.resolveAirportScope("West North Central");
    expect(resolution.notes.join(" ")).toContain("No airports in the dataset for: KS, ND, SD");
  });

  it("assigns every state to exactly one division (DC included)", () => {
    expect(censusDivisionOf("DC")).toBe("South Atlantic");
    expect(censusDivisionOf("ak")).toBe("Pacific");
    expect(censusDivisionOf("PR")).toBeNull();
  });

  it("returns a valid but empty area as empty, not as unknown", () => {
    // Every division has an airport in the 102-airport dataset, so use a state without one.
    const state = data.resolveAirportScope("Kansas");
    expect(state.status).toBe("empty");
    expect(state.resolvedAs).toBe("state");
    const fixture = syntheticAirports().filter((a) => !["AL", "KY", "MS", "TN"].includes(a.state));
    const division = resolveScope("East South Central", fixture);
    expect(division.status).toBe("empty");
    expect(division.resolvedAs).toBe("census_division");
  });

  it("resolves Texas to its several airports", () => {
    expect(codes("Texas")).toEqual(["AUS", "DAL", "DFW", "ELP", "HOU", "IAH", "SAT"]);
  });

  it("covers all six New England states with the real data", () => {
    const states = new Set(data.resolveAirportScope("New England").airports.map((a) => a.state));
    expect([...states].sort()).toEqual(["CT", "MA", "ME", "NH", "RI", "VT"]);
  });
});

describe("states, airports and the 'all' scope", () => {
  it("resolves state names and postal codes in any case", () => {
    expect(codes("California")).toContain("LAX");
    expect(codes(" ca ")).toContain("SFO");
    expect(data.resolveAirportScope("texas").resolvedAs).toBe("state");
  });

  it("resolves an airport code and 'all'", () => {
    const one = data.resolveAirportScope("bos");
    expect(one.resolvedAs).toBe("airport");
    expect(one.airports.map((a) => a.iata)).toEqual(["BOS"]);
    for (const text of ["all", "ALL", "", "  ", "nationwide"]) {
      const all = data.resolveAirportScope(text);
      expect(all.resolvedAs).toBe("all");
      expect(all.airports).toHaveLength(data.allAirports().length);
    }
    expect(data.resolveAirportScope(undefined).resolvedAs).toBe("all");
  });
});

describe("named metro aliases are data", () => {
  it("keeps LA, Bay Area, NYC and DC working", () => {
    // Radii are unchanged; the larger dataset simply has more airports inside them.
    expect(codes("LA")).toEqual(["BUR", "LAX", "LGB", "ONT", "SNA"]);
    expect(codes("Bay Area")).toEqual(["OAK", "SFO", "SJC"]);
    expect(codes("NYC")).toEqual(["EWR", "HPN", "JFK", "LGA"]);
    expect(codes("DC")).toEqual(["BWI", "DCA", "IAD"]);
    expect(codes("Southern California")).toEqual(["BUR", "LAX", "LGB", "ONT", "PSP", "SAN", "SNA"]);
    expect(data.resolveAirportScope("Bay Area").resolvedAs).toBe("metro");
  });

  it("says when an alias shadows a state postal code", () => {
    const notes = data.resolveAirportScope("LA").notes.join(" ");
    expect(notes).toContain("Louisiana");
  });

  it("accepts a caller-supplied alias row without any code change", () => {
    const fixture = syntheticAirports();
    const resolution = resolveScope("Test Metro", fixture, {
      metroAliases: [{ names: ["Test Metro"], label: "Test Metro area", center: { lat: 40, lon: -100 }, radius_miles: 10 }],
    });
    expect(resolution.resolvedAs).toBe("metro");
    expect(resolution.label).toBe("Test Metro area");
  });

  it("matches an airport's optional metro field", () => {
    const fixture = syntheticAirports().map((a, i) => (i < 3 ? { ...a, metro: "Greater Fixture, XX" } : a));
    const resolution = resolveScope("greater fixture xx", fixture);
    expect(resolution.resolvedAs).toBe("metro");
    expect(resolution.airports).toHaveLength(3);
  });
});

describe("Census metro areas (CBSA) from the real data", () => {
  it("resolves a metro by title, short title, '<city> metro' or CBSA code", () => {
    for (const scope of ["Boston-Cambridge-Newton, MA-NH", "Boston-Cambridge-Newton", "Boston metro", "14460"]) {
      const resolution = data.resolveAirportScope(scope);
      expect(resolution.resolvedAs).toBe("metro");
      expect(resolution.label).toBe("Boston-Cambridge-Newton, MA-NH");
      expect(resolution.airports.map((a) => a.iata).sort()).toEqual(["BOS", "MHT"]);
    }
    expect(codes("Chicago metro")).toEqual(["MDW", "ORD"]);
    expect(codes("Miami metro")).toEqual(["FLL", "MIA", "PBI"]);
  });

  it("asks which metro when '<city> metro' fits more than one", () => {
    const resolution = data.resolveAirportScope("Portland metro");
    expect(resolution.status).toBe("ambiguous");
    expect(resolution.options?.map((o) => o.scope).sort()).toEqual([
      "Portland-South Portland, ME",
      "Portland-Vancouver-Hillsboro, OR-WA",
    ]);
    for (const option of resolution.options!) expect(data.resolveAirportScope(option.scope).status).toBe("matched");
  });

  it("gives every airport a metro area", () => {
    expect(data.allAirports().every((a) => Boolean(a.metro && a.metro_code))).toBe(true);
  });
});

describe("Census Gazetteer places from the real data", () => {
  it("finds cities that have no seed row: Boise, Nashville, Honolulu, Louisville", () => {
    expect(codes("near Boise")).toEqual(["BOI"]);
    expect(codes("near Nashville")).toEqual(["BNA"]);
    expect(codes("near Honolulu")).toEqual(["HNL"]);
    expect(codes("near Louisville")).toEqual(["SDF"]);
  });

  it("settles a shared name by population only when one place clearly dominates", () => {
    expect(data.resolveAirportScope("near Dallas").label).toBe("50 mi around Dallas, TX");
    expect(data.resolveAirportScope("near Kansas City").status).toBe("ambiguous"); // MO vs KS, about 3x
  });

  it("does not let a small same-named city shadow a state", () => {
    expect(data.resolveAirportScope("Wyoming").resolvedAs).toBe("state");
    expect(data.resolveAirportScope("Indiana").resolvedAs).toBe("state");
  });
});

describe("near / within N miles of", () => {
  it("resolves 'near <city>' with the default radius", () => {
    const resolution = data.resolveAirportScope("near Boston");
    expect(resolution.resolvedAs).toBe("radius");
    expect(resolution.label).toBe("50 mi around Boston, MA");
    expect(resolution.airports.map((a) => a.iata).sort()).toEqual(["BOS", "MHT", "PVD"]);
  });

  it("respects an explicit radius in miles or kilometres", () => {
    expect(codes("within 100 miles of Boston")).toEqual(["BDL", "BOS", "MHT", "PVD", "PWM"]);
    expect(codes("within 160 km of Boston")).toEqual(codes("within 99 miles of Boston"));
    expect(codes("50-mile radius of JFK")).toEqual(["EWR", "HPN", "JFK", "LGA"]);
  });

  it("centers on an airport code, including that airport", () => {
    expect(codes("within 10 miles of SNA")).toEqual(["SNA"]);
    expect(codes("within 40 miles of LAX")).toEqual(["BUR", "LAX", "LGB", "SNA"]);
  });

  it("answers by city name from the Census Gazetteer (Santa Ana, Burbank)", () => {
    expect(codes("near Santa Ana")).toEqual(["BUR", "LAX", "LGB", "ONT", "SNA"]);
    expect(codes("within 10 miles of Santa Ana")).toEqual(["SNA"]);
    // The full gazetteer knows Burbank, IL as well as Burbank, CA, so a bare name is asked about.
    expect(data.resolveAirportScope("near Burbank").status).toBe("ambiguous");
    expect(codes("near Burbank, CA")).toEqual(expect.arrayContaining(["BUR", "LAX"]));
  });

  it("handles Anchorage without pulling in lower-48 airports", () => {
    expect(codes("near Anchorage")).toEqual(["ANC"]);
    expect(codes("within 1000 miles of Anchorage")).toEqual(["ANC"]);
  });

  it("reports an empty radius with the nearest covered airport", () => {
    const resolution = data.resolveAirportScope("near Cheyenne");
    expect(resolution.status).toBe("empty");
    expect(resolution.notes.join(" ")).toMatch(/Nearest covered airport: DEN /);
  });

  it("rejects out-of-range radii and unknown anchors without guessing", () => {
    expect(data.resolveAirportScope("within 0 miles of Boston").status).toBe("unknown");
    expect(data.resolveAirportScope("within 5000 miles of Boston").status).toBe("unknown");
    const unknown = data.resolveAirportScope("near Atlantis");
    expect(unknown.status).toBe("unknown");
    expect(unknown.airports).toEqual([]);
  });

  it("qualifies a place with a state", () => {
    expect(data.resolveAirportScope("near Portland, ME").airports.map((a) => a.iata)).toEqual(["PWM"]);
    const oregon = data.resolveAirportScope("near Portland OR");
    expect(oregon.airports.map((a) => a.iata)).toEqual(["PDX"]);
    expect(oregon.label).toBe("50 mi around Portland, OR");
  });
});

describe("ambiguity is reported, never silently picked", () => {
  it("flags Portland (ME or OR) with options that resolve", () => {
    const resolution = data.resolveAirportScope("Portland");
    expect(resolution.status).toBe("ambiguous");
    expect(resolution.airports).toEqual([]);
    // OR is about 9x ME, under the 10x needed to settle it; the gazetteer also has TX and TN.
    expect(resolution.options?.map((o) => o.label)).toEqual(
      expect.arrayContaining(["Portland, ME (city)", "Portland, OR (city)"]),
    );
    for (const option of resolution.options!) {
      expect(data.resolveAirportScope(option.scope).status).not.toBe("ambiguous");
    }
  });

  it("flags Washington (state vs DC)", () => {
    const resolution = data.resolveAirportScope("Washington");
    expect(resolution.status).toBe("ambiguous");
    const scopes = resolution.options!.map((o) => o.scope);
    expect(scopes).toContain("WA");
    expect(codes("WA")).toEqual(["GEG", "SEA"]);
    expect(codes("Washington DC")).toEqual(["BWI", "DCA", "IAD"]);
  });

  it("does not call a state and its same-named city ambiguous (New York)", () => {
    expect(data.resolveAirportScope("New York").resolvedAs).toBe("state");
  });

  it("flags a radius anchor that matches several places and offers a scope per option", () => {
    const resolution = data.resolveAirportScope("within 30 miles of Portland");
    expect(resolution.status).toBe("ambiguous");
    expect(resolution.options?.map((o) => o.scope)).toContain("within 30 miles of Portland, OR");
  });

  it("surfaces ambiguity through the tool instead of a table", () => {
    const out = rankAirports("Portland", "expansion", 3);
    expect(out.structured).toBeUndefined();
    expect(out.result.status).toBe("ambiguous");
    expect(out.result.options).toBeTruthy();
  });
});

describe("unknown scopes", () => {
  it("returns no match with suggestions, supported kinds and coverage", () => {
    const resolution = data.resolveAirportScope("Nowhere");
    expect(resolution.status).toBe("unknown");
    expect(resolution.airports).toEqual([]);
    const out = rankAirports("Nowhere", "expansion", 3);
    expect(out.structured).toBeUndefined();
    const coverage = out.result.coverage as ReturnType<typeof describeCoverage>;
    expect(coverage.airport_count).toBe(data.allAirports().length);
    expect(coverage.states).toContain("MA");
    expect(coverage.supported_scopes.length).toBeGreaterThan(5);
    expect(coverage.metro_aliases).toContain("Bay Area");
  });

  it("suggests the closest supported spellings for typos", () => {
    expect(data.resolveAirportScope("New Englnd").suggestions).toContain("New England");
    expect(data.resolveAirportScope("Calfornia").suggestions).toContain("California");
    expect(data.resolveAirportScope("Bostn").suggestions).toContain("near Boston, MA");
  });

  it("says when a three-letter code is not in the dataset", () => {
    const resolution = data.resolveAirportScope("EUG");
    expect(resolution.status).toBe("unknown");
    expect(resolution.notes.join(" ")).toContain("not an airport code in this dataset");
  });

  it("never returns everything for an unrecognized scope", () => {
    expect(data.airportsInScope("zzzz qqqq")).toEqual([]);
  });
});

/** 150 airports spread over every state, none from the real dataset. */
function syntheticAirports(): GeoAirport[] {
  const stateCodes = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
    "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
    "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  ];
  return Array.from({ length: 150 }, (_, i) => ({
    iata: `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}`,
    city: `Fixture City ${i}`,
    state: stateCodes[i % stateCodes.length],
    lat: 25 + (i % 25),
    lon: -120 + ((i * 3) % 50),
  }));
}

describe("scales beyond the bundled dataset", () => {
  const fixture = syntheticAirports();

  it("has unique codes so the fixture is meaningful", () => {
    expect(new Set(fixture.map((a) => a.iata)).size).toBe(fixture.length);
  });

  it("partitions 150 airports exactly across the four Census regions", () => {
    const total = ["Northeast", "Midwest", "South", "West"].reduce(
      (sum, region) => sum + resolveScope(region, fixture).airports.length,
      0,
    );
    expect(total).toBe(150);
  });

  it("partitions 150 airports exactly across the nine Census divisions", () => {
    const divisions = [
      "New England", "Middle Atlantic", "East North Central", "West North Central", "South Atlantic",
      "East South Central", "West South Central", "Mountain", "Pacific",
    ];
    const resolved = divisions.map((name) => resolveScope(name, fixture));
    expect(resolved.every((r) => r.resolvedAs === "census_division")).toBe(true);
    expect(resolved.reduce((sum, r) => sum + r.airports.length, 0)).toBe(150);
  });

  it("derives New England from state codes at any size", () => {
    const resolution = resolveScope("new england", fixture);
    const states = new Set(resolution.airports.map((a) => a.state));
    expect([...states].sort()).toEqual(["CT", "MA", "ME", "NH", "RI", "VT"]);
    expect(resolution.airports.length).toBe(fixture.filter((a) => states.has(a.state)).length);
  });

  it("resolves all, states, radius and aliases against the larger set", () => {
    expect(resolveScope("all", fixture).airports).toHaveLength(150);
    expect(resolveScope("Texas", fixture).airports.every((a) => a.state === "TX")).toBe(true);
    const radius = resolveScope(`within 300 miles of ${fixture[0].iata}`, fixture);
    expect(radius.resolvedAs).toBe("radius");
    expect(radius.airports.length).toBeGreaterThan(1);
    expect(radius.airports.length).toBeLessThan(150);
    expect(resolveScope("nyc", fixture).resolvedAs).toBe("metro");
  });

  it("describes coverage from the data, not from constants", () => {
    const coverage = describeCoverage(fixture);
    expect(coverage.airport_count).toBe(150);
    expect(coverage.states).toHaveLength(51);
    expect(coverage.census_divisions).toHaveLength(9);
  });

  it("uses a caller-supplied gazetteer and treats its names as ambiguous when they collide", () => {
    const places = [
      { name: "Fixtureville", state: "TX", lat: 32, lon: -97 },
      { name: "Fixtureville", state: "OH", lat: 40, lon: -83 },
    ];
    expect(resolveScope("Fixtureville", fixture, { places }).status).toBe("ambiguous");
    expect(resolveScope("near Fixtureville, OH", fixture, { places }).resolvedAs).toBe("radius");
  });
});

describe("natural phrasing", () => {
  it("reads trailing filler and 'including ...' clauses, and flags the simplification", () => {
    const plain = data.resolveAirportScope("Northeast US");
    expect(plain.resolvedAs).toBe("census_region");
    expect(plain.reinterpreted).toBe(true);
    const clause = data.resolveAirportScope("Northeast including New York and New Jersey");
    expect(clause.label).toBe("Northeast");
    expect(clause.notes.join(" ")).toContain("ignored");
    expect(data.resolveAirportScope("Northeast").reinterpreted).toBeUndefined();
  });

  it("still reports truly unknown phrasing as unknown", () => {
    expect(data.resolveAirportScope("Narnia area").status).toBe("unknown");
  });
});
