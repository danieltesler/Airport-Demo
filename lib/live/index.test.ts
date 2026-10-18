import { beforeEach, describe, expect, it } from "vitest";
import { LIVE_TOOLS, isLiveTool, liveToolSchemas, runLiveTool } from "./index";
import { makeDeps, mockFetch, resetLiveState } from "./testing";

beforeEach(resetLiveState);

describe("live tool registry", () => {
  it("has unique names, matching schema names, and an object schema requiring iata", () => {
    const names = LIVE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of LIVE_TOOLS) {
      expect(tool.schema.name).toBe(tool.name);
      expect(tool.schema.description.length).toBeGreaterThan(40);
      expect(tool.schema.input_schema).toMatchObject({ type: "object", required: ["iata"] });
    }
    expect(liveToolSchemas()).toHaveLength(LIVE_TOOLS.length);
  });

  it("does not collide with the existing tool names", () => {
    const existing = ["airport_profile", "rank_airports", "compare_airports", "long_haul_breakdown", "unmet_demand", "live_flights"];
    for (const name of existing) expect(isLiveTool(name)).toBe(false);
  });

  it("returns an error result for an unknown tool", async () => {
    expect((await runLiveTool("nope", {})).result.error).toMatch(/Unknown tool/);
  });

  it("never throws: an unexpected handler failure becomes an error result", async () => {
    const boom = (() => {
      throw new Error("kaboom with internal detail");
    }) as unknown as typeof fetch;
    const deps = { ...makeDeps(boom), resolveAirport: () => { throw new Error("kaboom with internal detail"); } };
    const out = await runLiveTool("faa_airport_status", { iata: "BOS" }, deps);
    expect(out.result.error).toBeTruthy();
    expect(JSON.stringify(out)).not.toContain("internal detail");
  });

  it("dispatches by name through the injected dependencies", async () => {
    const mock = mockFetch([["nasstatus.faa.gov", { body: "<AIRPORT_STATUS_INFORMATION></AIRPORT_STATUS_INFORMATION>" }]]);
    const out = await runLiveTool("faa_airport_status", { iata: "BOS" }, makeDeps(mock.fetchImpl));
    expect(out.result).toMatchObject({ available: true, status: "no_faa_program_reported" });
  });
});
