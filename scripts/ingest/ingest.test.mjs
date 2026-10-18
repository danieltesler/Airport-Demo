import { describe, expect, it } from "vitest";
import { addT100Row, createT100Accumulator, finalizeAirport, haulBucket, yearOverYearGrowth, MIN_DEPARTURES_FOR_RATIOS } from "./aggregate-t100.mjs";
import { addOntimeRow, createOntimeAccumulator, finalizeOntimeAirport, MIN_SCHEDULED_DEPARTURES } from "./aggregate-ontime.mjs";
import { selectCoverage } from "./coverage.mjs";
import { buildPlaces, cleanPlaceName, commonPlaceName, parseGeocoderGeographies } from "./geography.mjs";
import { countRunways } from "./reference.mjs";
import { splitCsvLine } from "./csv-stream.mjs";
import { buildPostBody } from "./fetch-t100.mjs";

const t100Row = (overrides = {}) => ({
  CLASS: "F", AIRCRAFT_CONFIG: "1", ORIGIN_COUNTRY: "US", ORIGIN: "AAA", DEST: "BBB", UNIQUE_CARRIER: "XX",
  ORIGIN_CITY_MARKET_ID: "30001", ORIGIN_CITY_NAME: "Alpha, AA",
  DEPARTURES_PERFORMED: "10", SEATS: "1000", PASSENGERS: "800", DISTANCE: "500", ...overrides,
});

describe("T-100 aggregation", () => {
  it("computes load factor as passengers over seats and haul mix by departures", () => {
    const acc = createT100Accumulator();
    addT100Row(acc, t100Row({ DEPARTURES_PERFORMED: "300", SEATS: "30000", PASSENGERS: "24000", DISTANCE: "500" }));
    addT100Row(acc, t100Row({ DEPARTURES_PERFORMED: "100", SEATS: "10000", PASSENGERS: "9000", DISTANCE: "2500", DEST: "CCC" }));
    const airport = finalizeAirport(acc.airports.get("AAA"));
    expect(airport.load_factor).toBe(0.825);
    expect(airport.haul_mix).toEqual({ short: 0.75, medium: 0, long: 0.25 });
    expect(airport.bts_city_market_id).toBe(30001);
  });

  it("excludes cargo classes, freight config and foreign origins", () => {
    const acc = createT100Accumulator();
    addT100Row(acc, t100Row({ CLASS: "G" }));
    addT100Row(acc, t100Row({ AIRCRAFT_CONFIG: "2" }));
    addT100Row(acc, t100Row({ ORIGIN_COUNTRY: "CA" }));
    addT100Row(acc, t100Row({ DEPARTURES_PERFORMED: "0" }));
    expect(acc.airports.size).toBe(0);
  });

  it("returns null ratios below the minimum departures instead of a default", () => {
    const acc = createT100Accumulator();
    addT100Row(acc, t100Row({ DEPARTURES_PERFORMED: String(MIN_DEPARTURES_FOR_RATIOS - 1) }));
    const airport = finalizeAirport(acc.airports.get("AAA"));
    expect(airport.load_factor).toBeNull();
    expect(airport.haul_mix).toBeNull();
  });

  it("uses the 1100 and 2200 mile thresholds with documented boundaries", () => {
    expect(haulBucket(1099)).toBe("short");
    expect(haulBucket(1100)).toBe("medium");
    expect(haulBucket(2200)).toBe("medium");
    expect(haulBucket(2201)).toBe("long");
    expect(haulBucket(0)).toBeNull();
  });

  it("aggregates routes per origin, destination and carrier", () => {
    const acc = createT100Accumulator();
    addT100Row(acc, t100Row({ PASSENGERS: "100", SEATS: "200" }));
    addT100Row(acc, t100Row({ PASSENGERS: "50", SEATS: "100" }));
    expect(acc.routes.get("AAA|BBB|XX")).toMatchObject({ passengers: 150, seats: 300, departures: 20, distance: 500 });
  });

  it("reports negative growth as negative and missing base as null", () => {
    expect(yearOverYearGrowth(95, 100)).toBe(-0.05);
    expect(yearOverYearGrowth(95, 0)).toBeNull();
    expect(yearOverYearGrowth(95, undefined)).toBeNull();
  });
});

describe("On-Time aggregation", () => {
  const flights = (count, overrides) => Array.from({ length: count }, () => ({ Origin: "AAA", Cancelled: "0.00", DepDelayMinutes: "0.00", DepDel15: "0.00", ...overrides }));

  it("computes averages over non-cancelled flights and cancel rate over all scheduled", () => {
    const acc = createOntimeAccumulator();
    const rows = [...flights(MIN_SCHEDULED_DEPARTURES - 200), ...flights(100, { DepDelayMinutes: "40.00", DepDel15: "1.00" }), ...flights(100, { Cancelled: "1.00", DepDelayMinutes: "" })];
    rows.forEach((row) => addOntimeRow(acc, row));
    const result = finalizeOntimeAirport(acc.airports.get("AAA"));
    expect(result.cancel_rate).toBe(0.02);
    expect(result.delayed_share).toBe(Number((100 / 4900).toFixed(4)));
    expect(result.avg_dep_delay_min).toBe(Number((4000 / 4900).toFixed(2)));
    expect(result.measured_departures).toBe(4900);
  });

  it("suppresses airports under the minimum flight count", () => {
    const acc = createOntimeAccumulator();
    flights(10).forEach((row) => addOntimeRow(acc, row));
    expect(finalizeOntimeAirport(acc.airports.get("AAA"))).toMatchObject({ avg_dep_delay_min: null, delayed_share: null, cancel_rate: null, scheduled_departures: 10 });
  });
});

describe("coverage", () => {
  it("keeps guaranteed airports and computes the covered share", () => {
    const pax = new Map([["A", 60], ["B", 30], ["C", 9], ["D", 1]]);
    const result = selectCoverage(pax, ["D"], 2);
    expect(result.selected).toEqual(["A", "B", "D"]);
    expect(result.coveredShare).toBeCloseTo(0.91);
  });

  it("fails loudly when a guaranteed airport has no traffic", () => {
    expect(() => selectCoverage(new Map([["A", 1]]), ["Z"], 1)).toThrow(/Z/);
  });
});

describe("reference and geography", () => {
  it("counts only open, non-helipad runways and keeps the legacy count", () => {
    const counts = countRunways([
      { airport_ident: "KAAA", closed: "0", le_ident: "04" },
      { airport_ident: "KAAA", closed: "1", le_ident: "09" },
      { airport_ident: "KAAA", closed: "0", le_ident: "H1" },
    ]);
    expect(counts.get("KAAA")).toEqual({ open: 1, legacyAllRows: 3 });
  });

  it("extracts CBSA, CSA and county from geocoder output and tolerates missing layers", () => {
    const parsed = parseGeocoderGeographies({
      "Metropolitan Statistical Areas": [{ GEOID: "14460", BASENAME: "Boston-Cambridge-Newton, MA-NH", NAME: "Boston-Cambridge-Newton, MA-NH Metro Area" }],
      Counties: [{ GEOID: "25025", NAME: "Suffolk County" }],
    });
    expect(parsed).toMatchObject({ cbsa_code: "14460", cbsa_name: "Boston-Cambridge-Newton, MA-NH", cbsa_type: "metropolitan", csa_code: null, county_fips: "25025" });
  });

  it("joins gazetteer places with population and drops small places", () => {
    const gazetteer = [
      { GEOID: "2507000", USPS: "MA", NAME: "Boston city", INTPTLAT: "42.3188", INTPTLONG: "-71.0846" },
      { GEOID: "2500001", USPS: "MA", NAME: "Tiny town", INTPTLAT: "42.0", INTPTLONG: "-71.0" },
    ];
    const population = [
      { SUMLEV: "162", STATE: "25", PLACE: "07000", POPESTIMATE2025: "650000" },
      { SUMLEV: "162", STATE: "25", PLACE: "00001", POPESTIMATE2025: "500" },
      { SUMLEV: "061", STATE: "25", PLACE: "07000", POPESTIMATE2025: "1" },
    ];
    const places = buildPlaces(gazetteer, population, 10000);
    expect(places).toEqual([{ name: "Boston", state: "MA", lat: 42.3188, lon: -71.0846, population: 650000, geoid: "2507000" }]);
    expect(cleanPlaceName("Nashville-Davidson metropolitan government")).toBe("Nashville-Davidson");
  });

  it("names consolidated city-county governments by their city", () => {
    expect(commonPlaceName("Nashville-Davidson metropolitan government (balance)")).toBe("Nashville");
    expect(commonPlaceName("Louisville/Jefferson County metro government (balance)")).toBe("Louisville");
    expect(commonPlaceName("Lexington-Fayette urban county")).toBe("Lexington");
    expect(commonPlaceName("Indianapolis city (balance)")).toBe("Indianapolis");
    // Ordinary hyphenated city names are kept whole.
    expect(commonPlaceName("Winston-Salem city")).toBe("Winston-Salem");
  });
});

describe("helpers", () => {
  it("splits quoted CSV cells and custom delimiters", () => {
    expect(splitCsvLine('"a,b",c,"d ""e"""')).toEqual(["a,b", "c", 'd "e"']);
    expect(splitCsvLine("a\tb", "\t")).toEqual(["a", "b"]);
  });

  it("builds the T-100 form body with the hidden state and the chosen columns", () => {
    const body = buildPostBody({ __VIEWSTATE: "vs" }, 2025);
    expect(body.get("__VIEWSTATE")).toBe("vs");
    expect(body.get("cboYear")).toBe("2025");
    expect(body.get("PASSENGERS")).toBe("on");
    expect(body.get("ORIGIN_CITY_MARKET_ID")).toBe("on");
  });
});
