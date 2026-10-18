/**
 * Replay fixtures: recorded REAL tool outputs (dataset-backed tools, so they are deterministic
 * and need no network) that other tests can reuse, for example the spoken-line guard.
 *
 * Each case is `{ name, tool, args }`; its recorded output lives in `<name>.json` next to this
 * file as `{ tool, args, output }` where `output` is the tool's { result, structured, assumptions,
 * uncertainty }. test/fixtures/tool-outputs/fixtures.test.ts re-runs every tool and fails if a
 * recording has drifted. Re-record with: RECORD_FIXTURES=1 npx vitest run test/fixtures
 */

import fs from "node:fs";
import path from "node:path";
import type { ToolOutput } from "../../../lib/tools";

export interface FixtureCase {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  /** What the turn exercises, for the reader. */
  covers: string;
}

export const FIXTURE_CASES: FixtureCase[] = [
  { name: "rank-northeast-expansion", tool: "rank_airports", args: { scope: "northeast", user_words: "northeast", metric: "expansion", top_n: 5 }, covers: "ranking with a region scope" },
  { name: "rank-misheard-northeast", tool: "rank_airports", args: { scope: "North East", user_words: "Stay the North East", metric: "expansion", top_n: 5 }, covers: "reinterpreted words (speech slip)" },
  { name: "rank-washington-state-shortfall", tool: "rank_airports", args: { scope: "Washington state", user_words: "WA", metric: "expansion", top_n: 5 }, covers: "fewer airports matched than asked for" },
  { name: "rank-portland-ambiguous", tool: "rank_airports", args: { scope: "Portland", user_words: "Portland", metric: "expansion" }, covers: "ambiguous place with options" },
  { name: "rank-atlantis-unknown", tool: "rank_airports", args: { scope: "Atlantis", user_words: "Atlantis", metric: "expansion" }, covers: "unknown place with suggestions and coverage" },
  { name: "compare-lax-sna", tool: "compare_airports", args: { iatas: ["LAX", "SNA"], metric: "congestion" }, covers: "head-to-head comparison" },
  { name: "compare-bay-area", tool: "compare_airports", args: { scope: "Bay Area", user_words: "Bay Area", metric: "congestion" }, covers: "area comparison" },
  { name: "compare-new-york-chicago-ambiguous", tool: "compare_airports", args: { user_words: "New York and Chicago", metric: "congestion" }, covers: "named cities that match several airports" },
  { name: "profile-jfk", tool: "airport_profile", args: { iata: "JFK" }, covers: "single airport deep dive" },
  { name: "long-haul-anc", tool: "long_haul_breakdown", args: { iata: "ANC" }, covers: "breakdown table" },
  { name: "unmet-demand-sfo", tool: "unmet_demand", args: { iata: "SFO" }, covers: "score drivers" },
  { name: "routes-oak", tool: "route_search", args: { origin: "OAK", top_n: 10 }, covers: "top routes, truncated" },
  { name: "routes-btv-sea-no-service", tool: "route_search", args: { origin: "BTV", destination: "SEA" }, covers: "no nonstop service in this data" },
  { name: "carrier-share-slc", tool: "carrier_share", args: { origin: "SLC", top_n: 8 }, covers: "carrier shares with operating carriers and an other bucket" },
  { name: "trend-oak-by-carrier", tool: "capacity_trend", args: { origin: "OAK", group_by: "carrier", top_n: 5 }, covers: "what changed, not why" },
  { name: "airports-bay-area", tool: "airport_search", args: { scope: "Bay Area", user_words: "Bay Area" }, covers: "airport search" },
];

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

export interface RecordedFixture {
  tool: string;
  args: Record<string, unknown>;
  output: ToolOutput;
}

export const fixturePath = (name: string): string => path.join(dir, `${name}.json`);

/** One recorded tool output. */
export function loadFixture(name: string): RecordedFixture {
  return JSON.parse(fs.readFileSync(fixturePath(name), "utf8")) as RecordedFixture;
}

/** Every recorded output, keyed by case name. */
export function loadAllFixtures(): Record<string, RecordedFixture> {
  return Object.fromEntries(FIXTURE_CASES.map((c) => [c.name, loadFixture(c.name)]));
}
