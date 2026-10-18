import { beforeEach, describe, expect, it } from "vitest";
import { faaAirportInfrastructure, parseFacility, parseRunways } from "./faaInfrastructure";
import { fixture, makeDeps, mockFetch, resetLiveState } from "./testing";

beforeEach(resetLiveState);

// Real captures for Boston Logan from the NTAD ArcGIS services on 2026-10-18 (attributes trimmed).
const facilityBody = fixture("ntad-facility-bos.real.json");
const runwayBody = fixture("ntad-runways-bos.real.json");
const routes = (facility = { body: facilityBody }, runways: { body?: string; status?: number } = { body: runwayBody }) =>
  [
    ["NTAD_Aviation_Facilities", facility],
    ["Runways_View", runways],
  ] as [string, { body?: string; status?: number }][];

describe("parsers (real capture)", () => {
  it("parses the facility record", () => {
    expect(parseFacility(JSON.parse(facilityBody))).toMatchObject({
      faaId: "BOS",
      towerType: "ATCT",
      part139Class: "I E",
      elevationFt: 19.1,
      acres: 2384,
      status: "O",
    });
  });
  it("parses runways longest first", () => {
    const runways = parseRunways(JSON.parse(runwayBody));
    expect(runways).toHaveLength(6);
    expect(runways[0]).toMatchObject({ id: "15R/33L", lengthFt: 10083 });
    expect(runways.map((r) => r.lengthFt)).toEqual([...runways.map((r) => r.lengthFt)].sort((a, b) => b! - a!));
  });
  it("returns null for an empty facility result", () => {
    expect(parseFacility({ features: [] })).toBeNull();
  });
  it("throws on a malformed shape (e.g. ArcGIS error JSON)", () => {
    expect(() => parseRunways({ error: { code: 400 } })).toThrow(/unexpected shape/);
  });
});

describe("faa_airport_infrastructure tool", () => {
  it("returns runway count, longest runway and facility facts", async () => {
    const mock = mockFetch(routes());
    const out = await faaAirportInfrastructure({ iata: "BOS" }, makeDeps(mock.fetchImpl));
    expect(out.result).toMatchObject({
      available: true,
      faa_id: "BOS",
      runway_count: 6,
      longest_runway_ft: 10083,
      control_tower_type: "ATCT",
      part_139_class: "I E",
    });
    const facilityUrl = new URL(mock.calls[0]);
    expect(facilityUrl.searchParams.get("where")).toBe("ICAO_ID='KBOS'");
    expect(new URL(mock.calls[1]).searchParams.get("where")).toBe("ARPT_ID='BOS'");
    expect(JSON.stringify(out.result).length).toBeLessThan(2000);
  });

  it("reports unavailable when the FAA record is missing", async () => {
    const mock = mockFetch(routes({ body: JSON.stringify({ features: [] }) }));
    const out = await faaAirportInfrastructure({ iata: "BOS" }, makeDeps(mock.fetchImpl));
    expect(out.result.available).toBe(false);
    expect(String(out.result.message)).toMatch(/no FAA airport record/);
  });

  it("reports unavailable when the runway query fails", async () => {
    const mock = mockFetch(routes(undefined, { status: 500 }));
    const out = await faaAirportInfrastructure({ iata: "BOS" }, makeDeps(mock.fetchImpl));
    expect(out.result).toMatchObject({ available: false });
    expect(String(out.result.message)).toContain("HTTP 500");
  });

  it("rejects bad input without a network call", async () => {
    const mock = mockFetch([]);
    const out = await faaAirportInfrastructure({ iata: "BOS' OR 1=1" }, makeDeps(mock.fetchImpl));
    expect(out.result.error).toBeTruthy();
    expect(mock.calls).toHaveLength(0);
  });
});
