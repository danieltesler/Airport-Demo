import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { metroPopulation, parseAcs, parseGeocoder } from "./census";
import { fixture, makeDeps, mockFetch, resetLiveState } from "./testing";

const KEY = "TEST-KEY-do-not-leak-123";
const geocoderBody = fixture("census-geocoder-bos.real.json"); // real capture, 2026-10-18
// SYNTHETIC: the ACS endpoint could not be called keyless (it redirects to "Missing Key"), so this follows the
// documented response shape: a header row, then one row per requested geography.
const acs = (pop: string, income: string) =>
  JSON.stringify([
    ["NAME", "B01003_001E", "B19013_001E", "metropolitan statistical area/micropolitan statistical area"],
    ["Boston-Cambridge-Newton, MA-NH Metro Area", pop, income, "14460"],
  ]);

const saved = { key: process.env.CENSUS_API_KEY, year: process.env.CENSUS_ACS_YEAR };
beforeEach(() => {
  resetLiveState();
  process.env.CENSUS_API_KEY = KEY;
  delete process.env.CENSUS_ACS_YEAR;
});
afterEach(() => {
  if (saved.key === undefined) delete process.env.CENSUS_API_KEY;
  else process.env.CENSUS_API_KEY = saved.key;
  if (saved.year === undefined) delete process.env.CENSUS_ACS_YEAR;
  else process.env.CENSUS_ACS_YEAR = saved.year;
});

describe("parsers", () => {
  it("extracts the MSA from a real geocoder response", () => {
    expect(parseGeocoder(JSON.parse(geocoderBody))).toEqual({
      cbsaCode: "14460",
      name: "Boston-Cambridge-Newton, MA-NH Metro Area",
    });
  });
  it("returns null when the point is in no metro area", () => {
    expect(parseGeocoder({ result: { geographies: { "Combined Statistical Areas": [] } } })).toBeNull();
  });
  it("throws on a malformed geocoder body", () => {
    expect(() => parseGeocoder({ errors: ["bad"] })).toThrow(/unexpected shape/);
  });
  it("maps ACS sentinels to null", () => {
    expect(parseAcs(JSON.parse(acs("4912303", "-666666666")))).toEqual({
      population: 4912303,
      medianHouseholdIncome: null,
    });
  });
});

describe("metro_population tool", () => {
  const routes = (current: object, previous: object): [string, object][] => [
    ["geocoding.geo.census.gov", { body: geocoderBody }],
    ["/data/2024/acs/acs1", current],
    ["/data/2023/acs/acs1", previous],
  ];

  it("returns population, growth and income with the key never in the output", async () => {
    const mock = mockFetch(routes({ body: acs("4912303", "112000") }, { body: acs("4900000", "105000") }) as never);
    const out = await metroPopulation({ iata: "BOS" }, makeDeps(mock.fetchImpl));
    expect(out.result).toMatchObject({
      available: true,
      metro_area: "Boston-Cambridge-Newton, MA-NH Metro Area",
      cbsa_code: "14460",
      acs_year: 2024,
      population: 4912303,
      population_prior_year: 4900000,
      median_household_income_usd: 112000,
    });
    expect(out.result.population_growth_yoy).toBeCloseTo(4912303 / 4900000 - 1, 4);
    expect(JSON.stringify(out)).not.toContain(KEY);

    const dataCall = mock.calls.find((u) => u.includes("/data/2024/acs/acs1"))!;
    expect(dataCall).toContain("for=metropolitan%20statistical%20area/micropolitan%20statistical%20area:14460");
    expect(dataCall).toContain("get=NAME,B01003_001E,B19013_001E");
    expect(dataCall).toContain(`key=${KEY}`);
  });

  it("still answers when the prior-year vintage is unavailable", async () => {
    const mock = mockFetch(routes({ body: acs("4912303", "112000") }, { status: 404 }) as never);
    const out = await metroPopulation({ iata: "BOS" }, makeDeps(mock.fetchImpl));
    expect(out.result).toMatchObject({ available: true, population_prior_year: null, population_growth_yoy: null });
  });

  it("says plainly that a key is required when none is configured, with no network call", async () => {
    delete process.env.CENSUS_API_KEY;
    const mock = mockFetch([]);
    const out = await metroPopulation({ iata: "BOS" }, makeDeps(mock.fetchImpl));
    expect(out.result).toMatchObject({ available: false });
    expect(String(out.result.message)).toMatch(/free API key/);
    expect(mock.calls).toHaveLength(0);
  });

  it("treats the Census 'missing/invalid key' redirect as a failure and does not leak the key", async () => {
    const mock = mockFetch(routes({ status: 302 }, { status: 302 }) as never);
    const out = await metroPopulation({ iata: "BOS" }, makeDeps(mock.fetchImpl));
    expect(out.result.available).toBe(false);
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("is unavailable when the airport is in no metropolitan area", async () => {
    const mock = mockFetch([["geocoding.geo.census.gov", { body: JSON.stringify({ result: { geographies: {} } }) }]]);
    const out = await metroPopulation({ iata: "BOS" }, makeDeps(mock.fetchImpl));
    expect(String(out.result.message)).toMatch(/not inside a Census metropolitan/);
  });

  it("honours CENSUS_ACS_YEAR and ignores junk values", async () => {
    process.env.CENSUS_ACS_YEAR = "2023";
    const ok = mockFetch([
      ["geocoding.geo.census.gov", { body: geocoderBody }],
      ["/data/2023/acs/acs1", { body: acs("1000", "50000") }],
      ["/data/2022/acs/acs1", { body: acs("990", "49000") }],
    ]);
    expect((await metroPopulation({ iata: "BOS" }, makeDeps(ok.fetchImpl))).result.acs_year).toBe(2023);

    resetLiveState();
    process.env.CENSUS_ACS_YEAR = "../../etc";
    const fallback = mockFetch(routes({ body: acs("1000", "1") }, { body: acs("990", "1") }) as never);
    expect((await metroPopulation({ iata: "BOS" }, makeDeps(fallback.fetchImpl))).result.acs_year).toBe(2024);
  });

  it("rejects bad input without a network call", async () => {
    const mock = mockFetch([]);
    expect((await metroPopulation({ iata: "Boston" }, makeDeps(mock.fetchImpl))).result.error).toBeTruthy();
    expect(mock.calls).toHaveLength(0);
  });
});
