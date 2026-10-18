/**
 * Registry of live public-API tools (FAA status, NOAA weather, BTS traffic, FAA
 * infrastructure, Census metro population).
 *
 * Wired into lib/tools.ts (TOOL_SCHEMAS spreads liveToolSchemas(); runTool dispatches via
 * isLiveTool/runLiveTool). LiveToolOutput is structurally identical to ToolOutput.
 *
 * Environment: CENSUS_API_KEY (free, https://api.census.gov/data/key_signup.html) enables
 * metro_population; without it that one tool returns a clear "not configured" result and
 * the other four work keyless. Optional CENSUS_ACS_YEAR overrides the ACS vintage.
 */

import { dataVintage, getAirport } from "../data";
import type { LiveDeps, LiveTool, LiveToolOutput, LiveToolSchema } from "./common";
import { btsTrafficTool } from "./btsTraffic";
import { censusTool } from "./census";
import { faaInfrastructureTool } from "./faaInfrastructure";
import { faaStatusTool } from "./faaStatus";
import { weatherTool } from "./weather";

export type { LiveDeps, LiveTool, LiveToolOutput, LiveToolSchema } from "./common";

export const LIVE_TOOLS: LiveTool[] = [
  faaStatusTool,
  weatherTool,
  btsTrafficTool,
  faaInfrastructureTool,
  censusTool,
];

const BY_NAME = new Map(LIVE_TOOLS.map((tool) => [tool.name, tool]));

/** Default dependencies: airports resolved against the bundled dataset (the allow-list). */
const defaultDeps: LiveDeps = {
  resolveAirport: (iata) => getAirport(iata),
  get datasetVintage() {
    return dataVintage();
  },
};

export const isLiveTool = (name: string): boolean => BY_NAME.has(name);

export const liveToolSchemas = (): LiveToolSchema[] => LIVE_TOOLS.map((tool) => tool.schema);

/** Run a live tool by name. Never throws: unexpected failures become an error result. */
export async function runLiveTool(
  name: string,
  args: Record<string, unknown>,
  deps: LiveDeps = defaultDeps,
): Promise<LiveToolOutput> {
  const tool = BY_NAME.get(name);
  if (!tool) return { result: { error: `Unknown tool '${name}'.` } };
  try {
    return await tool.handler(args ?? {}, deps);
  } catch {
    return { result: { error: `The live data tool '${name}' failed unexpectedly. No figures are available.` } };
  }
}
