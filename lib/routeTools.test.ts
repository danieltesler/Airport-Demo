import { describe, expect, it } from "vitest";
import * as data from "./data";
import { carrierTableSource, describeCarrier } from "./carriers";
import { loadRoutes, routesFrom } from "./routes";
import {
  MAX_AIRPORTS,
  MAX_CARRIERS,
  MAX_ROUTES,
  MAX_TREND_ROWS,
  airportSearch,
  capacityTrend,
  carrierShare,
  routeSearch,
  routeToolSchemas,
} from "./routeTools";
import { TOOL_SCHEMAS, runTool } from "./tools";

/** Every array nested anywhere in a value, so a test can prove no raw row list reached the model. */
function arraysIn(value: unknown): unknown[][] {
  if (Array.isArray(value)) return [value, ...value.flatMap(arraysIn)];
  if (value && typeof value === "object") return Object.values(value).flatMap(arraysIn);
  return [];
}

const asRecords = (value: unknown): Record<string, unknown>[] => value as Record<string, unknown>[];

describe("route_search on the real route table", () => {
  it("lists real destinations from BOS, sorted by passengers, matching a hand aggregation", async () => {
    const out = await routeSearch({ origin: "bos", top_n: 5 });
    const routes = asRecords(out.result.routes);
    expect(routes).toHaveLength(5);
    expect(routes.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < routes.length; i++) {
      expect(routes[i - 1].passengers as number).toBeGreaterThanOrEqual(routes[i].passengers as number);
    }
    const destinations = new Set((await loadRoutes()).filter((r) => r.origin === "BOS").map((r) => r.dest));
    for (const route of routes) expect(destinations.has(route.destination as string)).toBe(true);

    const top = routes[0].destination as string;
    const manual = (await routesFrom("BOS", 2025)).filter((r) => r.dest === top);
    expect(routes[0].passengers).toBe(manual.reduce((sum, r) => sum + r.passengers, 0));
    expect(routes[0].seats).toBe(manual.reduce((sum, r) => sum + r.seats, 0));
    expect(routes[0].departures).toBe(manual.reduce((sum, r) => sum + r.departures, 0));
  });

  it("agrees with the airport total: an unfiltered trend adds up to the airport's passengers", async () => {
    const out = await capacityTrend({ origin: "BOS" });
    const totals = out.result.totals as Record<string, number>;
    expect(totals.passengers_current).toBe(data.getAirport("BOS")!.annual_passengers);
  });

  it("shows the change from the prior year", async () => {
    const out = await routeSearch({ origin: "BOS", top_n: 25, sort_by: "seats" });
    const routes = asRecords(out.result.routes);
    expect(routes.every((r) => r.yoy_pct === null || typeof r.yoy_pct === "number")).toBe(true);
    expect(routes.some((r) => typeof r.yoy_pct === "number")).toBe(true);
    expect(out.structured?.columns.at(-1)).toBe("Seats YoY");
  });

  it("has no change data for 2024, the earliest year", async () => {
    const out = await routeSearch({ origin: "BOS", year: 2024, top_n: 3 });
    expect(out.result.yoy_note).toMatch(/earliest year/);
    expect(asRecords(out.result.routes).every((r) => r.yoy_pct === null)).toBe(true);
  });

  it("filters to one destination airport, including a non-covered one that is in the route data", async () => {
    const lhr = await routeSearch({ origin: "BOS", destination: "lhr" });
    expect(asRecords(lhr.result.routes).map((r) => r.destination)).toEqual(["LHR"]);
    const lax = await routeSearch({ origin: "BOS", destination: "LAX" });
    expect(asRecords(lax.result.routes).map((r) => r.destination)).toEqual(["LAX"]);
  });

  it("filters to a destination area resolved from the user's words", async () => {
    const out = await routeSearch({ origin: "BOS", destination: "sunshine", destination_words: "Florida", top_n: 25 });
    const codes = asRecords(out.result.routes).map((r) => r.destination as string);
    const florida = new Set(data.allAirports().filter((a) => a.state === "FL").map((a) => a.iata));
    expect(codes.length).toBeGreaterThan(3);
    expect(codes.every((code) => florida.has(code))).toBe(true);
    expect(out.structured?.caption).toContain("to Florida");
    expect(JSON.stringify(out.result.destination_filter)).toContain("covers only the airports in the dataset");
  });

  it("says 'No nonstop service in this data' without calling the market underserved", async () => {
    const out = await routeSearch({ origin: "BTV", destination: "SEA" });
    expect(out.result.no_service).toBe(true);
    expect(String(out.result.message)).toContain("No nonstop service in this data");
    expect(out.structured).toBeUndefined();
    expect(out.uncertainty).toMatch(/not show a market is 'underserved'/);
    expect(out.uncertainty).toMatch(/inference/);
  });
});

describe("input validation and failure paths", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["an airport that is not in the dataset", { origin: "ZZZ" }],
    ["a missing origin", {}],
    ["an origin that is not a three-letter code", { origin: "BOS; DROP TABLE" }],
    ["an origin shaped like a path", { origin: "../etc" }],
    ["an origin that is not a string", { origin: 42 }],
  ];
  for (const tool of [routeSearch, carrierShare, capacityTrend]) {
    for (const [label, args] of cases) {
      it(`${tool.name} rejects ${label}`, async () => {
        const out = await tool(args);
        expect(out.result.error).toBeTruthy();
        expect(out.structured).toBeUndefined();
        expect(out.result.known_airports).toBeTruthy();
      });
    }
  }

  it("limits years to 2024 and 2025", async () => {
    for (const year of [2023, 2026, "abc", 2025.5, -1]) {
      for (const tool of [routeSearch, carrierShare]) {
        const out = await tool({ origin: "BOS", year });
        expect(out.result.error).toMatch(/not available/);
        expect(out.result.valid_years).toEqual([2024, 2025]);
      }
    }
    expect((await routeSearch({ origin: "BOS", year: "2024" })).result.year).toBe(2024);
  });

  it("reports an unknown, ambiguous or empty destination scope with coverage, never an empty table", async () => {
    const unknown = await routeSearch({ origin: "BOS", destination_words: "Atlantis" });
    expect(unknown.result).toMatchObject({ status: "unknown" });
    expect(unknown.result.coverage).toBeTruthy();
    expect(unknown.structured).toBeUndefined();

    const ambiguous = await carrierShare({ origin: "BOS", destination_words: "Portland" });
    expect(ambiguous.result).toMatchObject({ status: "ambiguous" });
    expect(asRecords(ambiguous.result.options).length).toBeGreaterThan(1);

    const empty = await capacityTrend({ origin: "BOS", destination_words: "Kansas" });
    expect(empty.result).toMatchObject({ status: "empty" });
  });

  it("rejects an unknown sort or grouping, and bad counts", async () => {
    expect((await routeSearch({ origin: "BOS", sort_by: "revenue" })).result.valid_sort_by).toBeTruthy();
    expect((await capacityTrend({ origin: "BOS", group_by: "pilot" })).result.valid_group_by).toBeTruthy();
    expect((await routeSearch({ origin: "BOS", top_n: "lots" })).result.error).toMatch(/top_n must be a number/);
    expect((await routeSearch({ origin: "BOS", top_n: 0 })).result.error).toMatch(/at least 1/);
  });

  it("is reachable through runTool and turns bad arguments into an error result", async () => {
    expect(((await runTool("route_search", { origin: "BOS", top_n: 2 })).result.routes as unknown[]).length).toBe(2);
    expect((await runTool("route_search", { origin: 7 })).result.error).toBeTruthy();
  });
});

describe("shared scope resolution", () => {
  it("does not turn unrecognized words into 'all airports' when no scope was passed", async () => {
    const { compareAirports } = await import("./tools");
    const out = compareAirports([], "congestion", undefined, "Atlantis");
    expect(out.result).toMatchObject({ status: "unknown" });
    expect(out.structured).toBeUndefined();
  });
});

describe("caps and what reaches the model", () => {
  it("caps routes, carriers and trend rows, and says so", async () => {
    const routes = await routeSearch({ origin: "ATL", top_n: 1000 });
    expect(routes.result.returned).toBe(MAX_ROUTES);
    expect(routes.result.row_count as number).toBeGreaterThan(MAX_ROUTES);
    expect(routes.result.truncated).toBe(true);
    expect(String((routes.result.notes as string[])[0])).toContain(`capped at ${MAX_ROUTES}`);

    const carriers = await carrierShare({ origin: "ATL", top_n: 1000 });
    expect(carriers.result.returned as number).toBeLessThanOrEqual(MAX_CARRIERS);

    const trend = await capacityTrend({ origin: "ATL", top_n: 1000 });
    expect((trend.result.biggest_increases as unknown[]).length).toBeLessThanOrEqual(MAX_TREND_ROWS);
    expect((trend.result.biggest_cuts as unknown[]).length).toBeLessThanOrEqual(MAX_TREND_ROWS);
    expect(trend.result.truncated).toBe(true);

    const airports = await airportSearch({ user_words: "all", top_n: 1000 });
    expect(airports.result.returned).toBe(MAX_AIRPORTS);
    expect(airports.result.row_count).toBe(data.allAirports().length);
    expect(airports.result.truncated).toBe(true);
  });

  it("reports truncated=false when everything fits", async () => {
    const out = await routeSearch({ origin: "BOS", destination: "LAX", top_n: 5 });
    expect(out.result.truncated).toBe(false);
    expect(out.result.row_count).toBe(out.result.returned);
  });

  it("never puts raw rows or more than the cap into the model-visible result", async () => {
    const outputs = [
      await routeSearch({ origin: "ATL", top_n: 1000 }),
      await carrierShare({ origin: "ATL", top_n: 1000 }),
      await capacityTrend({ origin: "ATL", top_n: 1000 }),
      await airportSearch({ user_words: "all", top_n: 1000 }),
    ];
    const rawRowCount = (await routesFrom("ATL")).length;
    expect(rawRowCount).toBeGreaterThan(500);
    for (const out of outputs) {
      const text = JSON.stringify(out.result);
      expect(text.length).toBeLessThan(20_000);
      for (const list of arraysIn(out.result)) expect(list.length).toBeLessThanOrEqual(MAX_ROUTES);
      expect(text).not.toMatch(/"year":20\d\d,"origin"/); // the RouteRow shape
    }
  });
});

describe("carrier_share", () => {
  it("shares add up to 100% including the 'other' bucket, for seats and departures", async () => {
    const out = await carrierShare({ origin: "ATL", top_n: 4 });
    const carriers = asRecords(out.result.carriers);
    const other = out.result.other as Record<string, number>;
    expect(carriers).toHaveLength(4);
    expect(other.carrier_count).toBe((out.result.row_count as number) - 4);

    const seatShare = carriers.reduce((sum, c) => sum + (c.seat_share_pct as number), other.seat_share_pct);
    const departureShare = carriers.reduce((sum, c) => sum + (c.departure_share_pct as number), other.departure_share_pct);
    expect(seatShare).toBeCloseTo(100, 9);
    expect(departureShare).toBeCloseTo(100, 9);
    const seats = carriers.reduce((sum, c) => sum + (c.seats as number), other.seats);
    expect(seats).toBe(out.result.total_seats);
    expect(out.structured?.rows.at(-1)?.[0]).toBe(`Other (${other.carrier_count} carriers)`);
  });

  it("is led by the carrier with the most seats, with a real name for a known code", async () => {
    const out = await carrierShare({ origin: "ATL", top_n: 3 });
    const first = asRecords(out.result.carriers)[0];
    expect(first.code).toBe("DL");
    expect(first.name).toBe("Delta Air Lines");
    expect(first.seat_share_pct as number).toBeGreaterThan(50);
  });

  it("works for a route and for a destination area", async () => {
    const route = await carrierShare({ origin: "BOS", destination: "LAX" });
    expect(route.result.destination_filter).toBeTruthy();
    expect(route.structured?.caption).toContain("to LAX");
    const area = await carrierShare({ origin: "BOS", destination_words: "California", top_n: 3 });
    expect(area.result.returned).toBeGreaterThan(0);
  });

  it("labels regional operating carriers and adds the operating-carrier assumption", async () => {
    const out = await carrierShare({ origin: "SLC", top_n: 8 });
    const skywest = asRecords(out.result.carriers).find((c) => c.code === "OO");
    expect(skywest).toMatchObject({ name: "SkyWest Airlines", operating_carrier: true });
    expect(String(skywest!.label)).toContain("operating carrier");
    expect(out.assumptions?.join(" ")).toContain("operating carrier");
  });

  it("omits the 'other' bucket when every carrier is shown", async () => {
    const out = await carrierShare({ origin: "BOS", destination: "LAX", top_n: 15 });
    expect(out.result.other).toBeNull();
    const total = asRecords(out.result.carriers).reduce((sum, c) => sum + (c.seat_share_pct as number), 0);
    expect(Math.abs(total - 100)).toBeLessThan(0.15);
  });
});

describe("carrier names", () => {
  it("leaves an unmapped code as the raw code and never guesses", () => {
    expect(describeCarrier("K2")).toEqual({ code: "K2", name: null, operatingCarrier: false, label: "K2" });
    expect(describeCarrier("ZZ9").label).toBe("ZZ9");
  });

  it("marks regional operators and not the mainline brands", () => {
    for (const code of ["OO", "YX", "MQ", "9E", "OH", "QX", "YV"]) expect(describeCarrier(code).operatingCarrier).toBe(true);
    for (const code of ["WN", "AA", "DL", "UA", "B6", "AS", "NK"]) expect(describeCarrier(code).operatingCarrier).toBe(false);
  });

  it("states its source and covers at least 99% of 2025 seats", async () => {
    const source = carrierTableSource();
    expect(source.source).toMatch(/Bureau of Transportation Statistics/);
    expect(source.url).toMatch(/^https:\/\/www\.transtats\.bts\.gov\//);
    const rows = (await loadRoutes()).filter((r) => r.year === 2025);
    const known = rows.filter((r) => describeCarrier(r.carrier).name !== null).reduce((sum, r) => sum + r.seats, 0);
    expect(known / rows.reduce((sum, r) => sum + r.seats, 0)).toBeGreaterThan(0.99);
  });
});

describe("capacity_trend on the real route table", () => {
  it("explains the OAK decline by carrier: Southwest, Spirit and Delta cut the most seats", async () => {
    const out = await capacityTrend({ origin: "OAK", group_by: "carrier", top_n: 5 });
    const totals = out.result.totals as Record<string, number>;
    expect(totals.seats_change).toBeLessThan(0);
    expect(totals.passengers_change_pct).toBeLessThan(0);
    const cutCodes = asRecords(out.result.biggest_cuts).map((c) => c.key);
    expect(cutCodes.slice(0, 3)).toEqual(["WN", "NK", "DL"]);
    expect(out.uncertainty).toMatch(/not why/);
    expect(out.uncertainty).toMatch(/underserved/);
  });

  it("defaults to carriers for a single route and to destinations otherwise", async () => {
    expect((await capacityTrend({ origin: "BOS", destination: "LAX" })).result.group_by).toBe("carrier");
    expect((await capacityTrend({ origin: "BOS" })).result.group_by).toBe("destination");
    expect((await capacityTrend({ origin: "BOS", destination_words: "Florida" })).result.group_by).toBe("destination");
  });

  it("builds a table whose rows match its columns, led by a total row", async () => {
    const out = await capacityTrend({ origin: "OAK" });
    const table = out.structured!;
    expect(table.rows[0][0]).toBe("Total");
    for (const row of table.rows) expect(row).toHaveLength(table.columns.length);
    expect(table.caption).toContain("2024 to 2025");
  });
});

describe("airport_search", () => {
  it("finds the Bay Area airports with state, metro and 2025 passengers, busiest first", async () => {
    const out = await airportSearch({ scope: "Bay Area", user_words: "Bay Area" });
    const airports = asRecords(out.result.airports);
    expect(airports.map((a) => a.iata)).toEqual(["SFO", "SJC", "OAK"]);
    expect(airports[0]).toMatchObject({ state: "CA", passengers: data.getAirport("SFO")!.annual_passengers });
    expect(String(airports[2].metro_area)).toContain("San Francisco");
    expect(out.structured?.caption).toBe("Scope: San Francisco Bay Area · metro area · 3 airports matched · top 3 by 2025 passengers");
    expect(out.result.truncated).toBe(false);
  });

  it("prefers the user's words over a narrowed scope, like the other scope tools", async () => {
    const out = await airportSearch({ scope: "new england", user_words: "northeast", top_n: 25 });
    expect(out.result.scope_label).toBe("Northeast");
    expect((out.result.scope_notes as string[]).join(" ")).toContain("do not describe it as 'new england'");
  });

  it("reports ambiguous, unknown and empty places with the shared wording and coverage", async () => {
    const ambiguous = await airportSearch({ user_words: "Portland" });
    expect(ambiguous.result).toMatchObject({ status: "ambiguous", error: expect.stringContaining("ambiguous") });
    expect(ambiguous.result.coverage).toBeTruthy();
    const unknown = await airportSearch({ user_words: "Atlantis" });
    expect(unknown.result).toMatchObject({ status: "unknown", error: expect.stringContaining("not recognized") });
    const empty = await airportSearch({ user_words: "Kansas" });
    expect(empty.result).toMatchObject({ status: "empty" });
  });

  it("asks for place words when none are given, and shows 'insufficient data' for a missing figure", async () => {
    expect((await airportSearch({})).result.error).toMatch(/user_words/);
    const airport = data.getAirport("BTV")!;
    const saved = airport.annual_passengers;
    airport.annual_passengers = Number.NaN;
    try {
      const out = await airportSearch({ user_words: "BTV" });
      expect(out.structured?.rows[0].at(-1)).toBe("insufficient data");
      expect(asRecords(out.result.airports)[0].passengers).toBeNull();
    } finally {
      airport.annual_passengers = saved;
    }
  });
});

describe("structured payload and registration", () => {
  it("returns a table with code-owned caption, assumptions and the underserved caveat for every route tool", async () => {
    const outputs = [
      await routeSearch({ origin: "BOS", top_n: 3 }),
      await carrierShare({ origin: "BOS", top_n: 3 }),
      await capacityTrend({ origin: "BOS", top_n: 3 }),
    ];
    for (const out of outputs) {
      expect(out.structured?.kind).toBe("metric");
      expect(out.structured?.caption).toMatch(/BOS/);
      for (const row of out.structured!.rows) expect(row).toHaveLength(out.structured!.columns.length);
      expect(out.assumptions?.join(" ")).toMatch(/enplaned passengers per segment/);
      expect(out.assumptions?.join(" ")).toMatch(/great-circle/);
      expect(out.assumptions?.join(" ")).toMatch(/102 airports/);
      expect(out.assumptions?.join(" ")).toMatch(/latest complete year/);
      expect(out.uncertainty).toMatch(/not show a market is 'underserved'/);
      expect(JSON.stringify(out.result)).not.toContain(out.structured!.caption!);
    }
  });

  it("registers four provider-neutral schemas with tight arguments", () => {
    const names = routeToolSchemas().map((t) => t.name);
    expect(names).toEqual(["route_search", "carrier_share", "capacity_trend", "airport_search"]);
    for (const name of names) expect(TOOL_SCHEMAS.map((t) => t.name)).toContain(name);
    const search = routeToolSchemas()[0].input_schema.properties as Record<string, { enum?: unknown[] }>;
    expect(search.year.enum).toEqual([2024, 2025]);
    expect(search.sort_by.enum).toEqual(["passengers", "seats", "departures"]);
    const airport = routeToolSchemas()[3];
    const props = airport.input_schema.properties as Record<string, { description: string }>;
    expect(props.scope.description).toContain("VERBATIM");
    expect(props.user_words).toBeTruthy();
    expect(airport.input_schema.required).toEqual(["user_words"]);
  });
});
