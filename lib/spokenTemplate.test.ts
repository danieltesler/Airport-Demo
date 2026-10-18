import { beforeAll, describe, expect, it } from "vitest";
import { capacityTrend, carrierShare, routeSearch } from "./routeTools";
import { guardSpoken } from "./spokenGuard";
import { splitIntoSentences } from "./sentences";
import { toSpokenSummary } from "./spoken";
import { airportProfile, compareAirports, longHaulBreakdown, rankAirports, unmetDemand, type ToolOutput } from "./tools";
import { faaAirportStatus } from "./live/faaStatus";
import { weatherTool } from "./live/weather";
import { btsTrafficTool } from "./live/btsTraffic";
import { faaInfrastructureTool } from "./live/faaInfrastructure";
import { fixture, makeDeps, mockFetch, resetLiveState } from "./live/testing";

/**
 * The template is the safety net the voice falls back to, so it must itself be something the guard
 * would accept: every figure it speaks is in the tool results at the precision it was said with.
 */
describe("template v2 passes the same guard as the model's line, for every real tool kind", () => {
  let outputs: Record<string, ToolOutput>;

  beforeAll(async () => {
    resetLiveState();
    const faa = mockFetch([["nasstatus.faa.gov", { body: fixture("faa-nas-status.real.xml") }]]);
    const metar = mockFetch([["aviationweather.gov", { body: fixture("metar-kjfk.real.json") }]]);
    const bts = mockFetch([["", { body: fixture("bts-t100-bos.real.json") }]]);
    const infra = mockFetch([["ntad", { body: fixture("ntad-facility-bos.real.json") }], ["", { body: fixture("ntad-runways-bos.real.json") }]]);
    outputs = {
      "ranking, expansion, New England": rankAirports("new_england", "expansion", 3),
      "ranking, congestion, all": rankAirports("all", "congestion", 5),
      "ranking, unmet demand, Alaska": rankAirports("Alaska", "unmet_demand", 3),
      "ranking, one airport": rankAirports("Alaska", "expansion", 1),
      "comparison, congestion": compareAirports(["LAX", "SFO"], "congestion"),
      "comparison, expansion, three airports": compareAirports(["BOS", "JFK", "SEA"], "expansion"),
      "haul mix": longHaulBreakdown("ANC"),
      "unmet demand drivers": unmetDemand("SFO"),
      "route search": await routeSearch({ origin: "OAK" }),
      "carrier share": await carrierShare({ origin: "OAK" }),
      "capacity trend": await capacityTrend({ origin: "OAK" }),
      "FAA status": await faaAirportStatus({ iata: "SAN" }, makeDeps(faa.fetchImpl)),
      weather: await weatherTool.handler({ iata: "JFK" }, makeDeps(metar.fetchImpl)),
      "BTS traffic": await btsTrafficTool.handler({ iata: "BOS" }, makeDeps(bts.fetchImpl)),
      "FAA infrastructure": await faaInfrastructureTool.handler({ iata: "BOS" }, makeDeps(infra.fetchImpl)),
    };
  });

  it("covers each tool kind", () => {
    expect(Object.keys(outputs).length).toBeGreaterThanOrEqual(15);
  });

  it.each([
    "ranking, expansion, New England",
    "ranking, congestion, all",
    "ranking, unmet demand, Alaska",
    "ranking, one airport",
    "comparison, congestion",
    "comparison, expansion, three airports",
    "haul mix",
    "unmet demand drivers",
    "route search",
    "carrier share",
    "capacity trend",
    "FAA status",
    "weather",
    "BTS traffic",
    "FAA infrastructure",
  ])("%s", (name) => {
    const output = outputs[name];
    const spoken = toSpokenSummary(output.structured, output.uncertainty);
    expect(spoken, "a sensible one- or two-sentence summary").toBeTruthy();

    const sentences = splitIntoSentences(spoken as string);
    expect(sentences.length).toBeLessThanOrEqual(2);
    expect((spoken as string).length).toBeLessThanOrEqual(260);
    expect(spoken).not.toMatch(/out of 100|composite|sub-score|[()%*#]/);

    // The guard sees the template's own (already spelled-out) wording, exactly as it would a model line.
    const verdict = guardSpoken({ spoken: spoken as string, toolOutputs: [output] });
    expect(verdict.reasons, spoken as string).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("is a fixed point: the template's text is unchanged by passing through the guard", () => {
    const output = outputs["ranking, expansion, New England"];
    const spoken = toSpokenSummary(output.structured, output.uncertainty) as string;
    expect(guardSpoken({ spoken, toolOutputs: [output] }).spoken).toBe(spoken);
  });

  it("does not read nonsense for the live tables Daredevil found", () => {
    const weather = toSpokenSummary(outputs.weather.structured) as string;
    expect(weather).not.toMatch(/visibility|sm,|kt/i);
    const bts = toSpokenSummary(outputs["BTS traffic"].structured) as string;
    expect(bts).not.toMatch(/to 05|2026 to/);
    const infra = toSpokenSummary(outputs["FAA infrastructure"].structured) as string;
    expect(infra).not.toMatch(/acres|\d{5}/i);
    const carriers = toSpokenSummary(outputs["carrier share"].structured) as string;
    expect(carriers).not.toMatch(/\bDL\b|\d{6}/);
  });

  it("profile (no table) has no template, so it falls back to the reply prose", () => {
    expect(airportProfile("BOS").structured ?? null).toBeNull();
  });
});
