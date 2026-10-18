/**
 * A cached live answer must report the time it was really fetched, not "now": the table caption
 * ("retrieved 14:32 UTC") and the footer promise the tool's own retrieval time. The clock is
 * injected through the tool's deps, so no real time passes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { btsAirportTraffic } from "./btsTraffic";
import { metroPopulation } from "./census";
import { faaAirportInfrastructure } from "./faaInfrastructure";
import { faaAirportStatus } from "./faaStatus";
import { airportWeather } from "./weather";
import { fixture, makeDeps, mockFetch, resetLiveState } from "./testing";

const T0 = new Date("2026-10-18T14:00:00Z");
const at = (secondsLater: number) => new Date(T0.getTime() + secondsLater * 1000);

beforeEach(resetLiveState);

describe("retrieved_at is the real fetch time", () => {
  it("faa_airport_status: a cache hit 30 s later still says 14:00:00", async () => {
    const mock = mockFetch([["nasstatus.faa.gov", { body: fixture("faa-nas-status.real.xml") }]]);
    const first = await faaAirportStatus({ iata: "SAN" }, makeDeps(mock.fetchImpl, T0));
    const second = await faaAirportStatus({ iata: "SAN" }, makeDeps(mock.fetchImpl, at(30)));
    expect(mock.calls).toHaveLength(1); // the second answer came from cache
    expect(first.result.retrieved_at).toBe("2026-10-18T14:00:00.000Z");
    expect(second.result.retrieved_at).toBe("2026-10-18T14:00:00.000Z");
  });

  it("faa_airport_status: after the cache expires the new fetch time is reported", async () => {
    const mock = mockFetch([["nasstatus.faa.gov", { body: fixture("faa-nas-status.real.xml") }]]);
    await faaAirportStatus({ iata: "SAN" }, makeDeps(mock.fetchImpl, T0));
    const later = await faaAirportStatus({ iata: "SAN" }, makeDeps(mock.fetchImpl, at(61)));
    expect(mock.calls).toHaveLength(2);
    expect(later.result.retrieved_at).toBe("2026-10-18T14:01:01.000Z");
  });

  it("airport_weather: reports the older of the cached observation and forecast", async () => {
    const mock = mockFetch([
      ["/metar", { body: fixture("metar-kjfk.real.json") }],
      ["/taf", { body: fixture("taf-kjfk.real.json") }],
    ]);
    await airportWeather({ iata: "JFK" }, makeDeps(mock.fetchImpl, T0));
    const cached = await airportWeather({ iata: "JFK" }, makeDeps(mock.fetchImpl, at(60)));
    expect(mock.calls).toHaveLength(2);
    expect(cached.result.retrieved_at).toBe("2026-10-18T14:00:00.000Z");
  });

  it("bts_airport_traffic: a 6-hour cache hit keeps its fetch time", async () => {
    const mock = mockFetch([["data.bts.gov", { body: fixture("bts-t100-bos.real.json") }]]);
    await btsAirportTraffic({ iata: "BOS" }, makeDeps(mock.fetchImpl, T0));
    const cached = await btsAirportTraffic({ iata: "BOS" }, makeDeps(mock.fetchImpl, at(3600)));
    expect(mock.calls).toHaveLength(1);
    expect(cached.result.retrieved_at).toBe("2026-10-18T14:00:00.000Z");
  });

  it("faa_airport_infrastructure: a 24-hour cache hit keeps its fetch time", async () => {
    const mock = mockFetch([
      ["NTAD_Aviation_Facilities", { body: fixture("ntad-facility-bos.real.json") }],
      ["Runways_View", { body: fixture("ntad-runways-bos.real.json") }],
    ]);
    await faaAirportInfrastructure({ iata: "BOS" }, makeDeps(mock.fetchImpl, T0));
    const cached = await faaAirportInfrastructure({ iata: "BOS" }, makeDeps(mock.fetchImpl, at(7200)));
    expect(cached.result.retrieved_at).toBe("2026-10-18T14:00:00.000Z");
  });

  describe("metro_population", () => {
    const saved = process.env.CENSUS_API_KEY;
    beforeEach(() => {
      process.env.CENSUS_API_KEY = "test-key";
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.CENSUS_API_KEY;
      else process.env.CENSUS_API_KEY = saved;
    });

    it("keeps the fetch time on a cache hit", async () => {
      const acs = JSON.stringify([
        ["NAME", "B01003_001E", "B19013_001E", "metropolitan statistical area/micropolitan statistical area"],
        ["Boston-Cambridge-Newton, MA-NH Metro Area", "4912303", "112000", "14460"],
      ]);
      const mock = mockFetch([
        ["geocoding.geo.census.gov", { body: fixture("census-geocoder-bos.real.json") }],
        ["/acs/acs1", { body: acs }],
      ]);
      await metroPopulation({ iata: "BOS" }, makeDeps(mock.fetchImpl, T0));
      const cached = await metroPopulation({ iata: "BOS" }, makeDeps(mock.fetchImpl, at(600)));
      expect(cached.result.retrieved_at).toBe("2026-10-18T14:00:00.000Z");
    });
  });
});
