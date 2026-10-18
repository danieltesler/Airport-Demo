// Compares the data the app reads now (data/airports.json) with a fresh staging build, field by
// field and score by score, using the app's own scorer and anchor rule (lib/scoring.ts,
// lib/anchors.ts, loaded read-only through Vite). Run it before `npm run promote:data` to see
// what a refresh would change.
//   node scripts/ingest/before-after.mjs
import { readFile, writeFile } from "node:fs/promises";
import { ROOT, STAGING_DIR, fail } from "./common.mjs";
import { loadAppModules } from "./app-modules.mjs";

const COMPARED_FIELDS = ["annual_passengers", "annual_departures", "runways", "pax_growth_yoy", "load_factor", "avg_dep_delay_min", "delayed_share", "cancel_rate"];
const HAUL_PARTS = ["short", "medium", "long"];
const METRICS = ["congestion", "unmet_demand", "expansion"];

const round = (n, dp = 3) => (typeof n === "number" ? Math.round(n * 10 ** dp) / 10 ** dp : n);

/** Score and rank every airport; airports with insufficient data get score null and no rank. */
function scoreAll(airports, scoring) {
  const scored = new Map(airports.map((a) => [a.iata, Object.fromEntries(METRICS.map((m) => [m, scoring.METRIC_SCORERS[m](a).score]))]));
  for (const metric of METRICS) {
    [...scored.entries()]
      .filter(([, s]) => s[metric] !== null)
      .sort((a, b) => b[1][metric] - a[1][metric])
      .forEach(([, s], i) => (s[`${metric}_rank`] = i + 1));
  }
  return scored;
}

function anchorChecks(airports, anchors, scoring) {
  return Object.fromEntries(
    Object.entries(scoring.ANCHOR_INPUTS).map(([key, input]) => {
      const values = airports.map(input).filter((v) => typeof v === "number" && Number.isFinite(v));
      return [key, { derived_from_staging: anchors.deriveAnchor(values), in_code: scoring.ANCHORS[key] }];
    }),
  );
}

function fieldRows(current, next) {
  const rows = COMPARED_FIELDS.map((field) => ({ field, current: current[field] ?? null, next: next[field] ?? null }));
  for (const part of HAUL_PARTS) rows.push({ field: `haul_mix.${part}`, current: current.haul_mix?.[part] ?? null, next: next.haul_mix?.[part] ?? null });
  return rows.filter((r) => r.current !== r.next);
}

function topMovers(shared, currentScores, nextScores, metric) {
  return shared
    .map((iata) => ({ iata, before: currentScores.get(iata), after: nextScores.get(iata) }))
    .filter(({ before, after }) => before[metric] !== null && after[metric] !== null)
    .map(({ iata, before, after }) => ({
      iata, rank_before: before[`${metric}_rank`], rank_after: after[`${metric}_rank`],
      score_before: round(before[metric], 1), score_after: round(after[metric], 1),
    }))
    .sort((a, b) => Math.abs(b.rank_before - b.rank_after) - Math.abs(a.rank_before - a.rank_after))
    .slice(0, 8);
}

const fmt = (value) => (value === null || value === undefined ? "null" : String(round(value, 4)));

function renderMarkdown(report) {
  const lines = ["# Data refresh preview: current app data vs staging build", "", `Generated ${report.generated_at}. Nothing here is promoted until \`npm run promote:data\`.`, ""];
  lines.push(`Airports added: ${report.added.join(", ") || "none"}. Removed: ${report.removed.join(", ") || "none"}.`, "");
  lines.push("## Biggest rank moves (airports in both files, same scorer)", "");
  for (const metric of METRICS) {
    lines.push(`### ${metric}`, "", "| Airport | Rank now | Rank after | Score now | Score after |", "|---|---|---|---|---|");
    for (const m of report.top_movers[metric]) lines.push(`| ${m.iata} | ${m.rank_before} | ${m.rank_after} | ${m.score_before} | ${m.score_after} |`);
    lines.push("");
  }
  lines.push(`Airports with insufficient data for a score after the refresh: ${report.unscorable.join(", ") || "none"}`, "");
  lines.push("## Anchors: the rule applied to the staging data vs lib/scoring.ts", "", "| Input | Derived (staging) | In code |", "|---|---|---|");
  for (const [key, a] of Object.entries(report.anchor_checks)) {
    lines.push(`| ${key} | ${a.derived_from_staging.low} .. ${a.derived_from_staging.high} | ${a.in_code.low} .. ${a.in_code.high} |`);
  }
  lines.push("", "## Changed fields per airport (current -> staging)", "");
  for (const c of report.airports.filter((x) => x.fields.length > 0)) {
    lines.push(`### ${c.iata}`, "", "| Field | Current | Staging |", "|---|---|---|");
    for (const f of c.fields) lines.push(`| ${f.field} | ${fmt(f.current)} | ${fmt(f.next)} |`);
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const current = JSON.parse(await readFile(`${ROOT}data/airports.json`, "utf-8")).airports;
  const next = JSON.parse(await readFile(`${STAGING_DIR}/airports.next.json`, "utf-8")).airports;
  const currentByIata = new Map(current.map((a) => [a.iata, a]));
  const nextByIata = new Map(next.map((a) => [a.iata, a]));
  const shared = next.map((a) => a.iata).filter((iata) => currentByIata.has(iata));

  const { modules: [anchors, scoring], close } = await loadAppModules(["/lib/anchors.ts", "/lib/scoring.ts"]);
  try {
    const currentScores = scoreAll(current, scoring);
    const nextScores = scoreAll(next, scoring);
    const report = {
      generated_at: new Date().toISOString(),
      added: next.map((a) => a.iata).filter((iata) => !currentByIata.has(iata)),
      removed: current.map((a) => a.iata).filter((iata) => !nextByIata.has(iata)),
      unscorable: [...nextScores.entries()].filter(([, s]) => METRICS.some((m) => s[m] === null)).map(([iata]) => iata),
      top_movers: Object.fromEntries(METRICS.map((m) => [m, topMovers(shared, currentScores, nextScores, m)])),
      anchor_checks: anchorChecks(next, anchors, scoring),
      airports: shared.map((iata) => ({ iata, fields: fieldRows(currentByIata.get(iata), nextByIata.get(iata)) })),
    };
    await writeFile(`${STAGING_DIR}/before_after.json`, JSON.stringify(report, null, 1) + "\n");
    await writeFile(`${STAGING_DIR}/before_after.md`, renderMarkdown(report) + "\n");
    console.log("Wrote data/staging/before_after.json and before_after.md");
  } finally {
    await close();
  }
}

main().catch((error) => fail(error.stack ?? String(error)));
