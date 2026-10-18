// Applies the anchor rule (lib/anchors.ts) to a dataset and compares the result with the
// constants in lib/scoring.ts. Exits non-zero when they differ.
//
//   npm run anchors                      (data/airports.json, what the app reads)
//   npm run anchors -- --staging         (data/staging/airports.next.json, before promoting)
//
// When a data refresh moves an anchor, copy the derived values printed here into ANCHORS in
// lib/scoring.ts. Never edit an anchor to another value: lib/anchors.test.ts will reject it.
import { readFile } from "node:fs/promises";
import { ROOT, STAGING_DIR, fail } from "./ingest/common.mjs";
import { loadAppModules } from "./ingest/app-modules.mjs";

async function main() {
  const staging = process.argv.includes("--staging");
  const path = staging ? `${STAGING_DIR}/airports.next.json` : `${ROOT}data/airports.json`;
  const airports = JSON.parse(await readFile(path, "utf-8")).airports;
  const { modules: [anchors, scoring], close } = await loadAppModules(["/lib/anchors.ts", "/lib/scoring.ts"]);
  try {
    let differ = 0;
    console.log(`Anchor rule: p${anchors.ANCHOR_LOW_PERCENTILE * 100} / p${anchors.ANCHOR_HIGH_PERCENTILE * 100}, ` +
      `rounded outward to ${anchors.ANCHOR_SIGNIFICANT_FIGURES} significant figures, over ${airports.length} airports (${staging ? "staging" : "promoted"} data)`);
    for (const [key, input] of Object.entries(scoring.ANCHOR_INPUTS)) {
      const values = airports.map(input).filter((v) => typeof v === "number" && Number.isFinite(v));
      const raw = { low: anchors.percentile(values, anchors.ANCHOR_LOW_PERCENTILE), high: anchors.percentile(values, anchors.ANCHOR_HIGH_PERCENTILE) };
      const derived = anchors.deriveAnchor(values);
      const inCode = scoring.ANCHORS[key];
      const same = derived.low === inCode.low && derived.high === inCode.high;
      if (!same) differ++;
      console.log(
        `${same ? "ok  " : "DIFF"} ${key.padEnd(22)} raw ${raw.low.toPrecision(4)} .. ${raw.high.toPrecision(4)}  ` +
          `derived ${derived.low} .. ${derived.high}  in code ${inCode.low} .. ${inCode.high}  (n=${values.length})`,
      );
    }
    if (differ > 0) fail(`${differ} anchor(s) differ from the rule applied to this data; update ANCHORS in lib/scoring.ts to the derived values.`);
  } finally {
    await close();
  }
}

main().catch((error) => fail(error.stack ?? String(error)));
