// Downloads BTS On-Time Performance (Reporting Carrier) monthly zips from the public
// PREZIP directory: plain GETs, no form and no login. Streams to disk, skips cached files.
import { createWriteStream } from "node:fs";
import { mkdir, stat, rename } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { CACHE_DIR, USER_AGENT, fail } from "./common.mjs";

const PREZIP = "https://transtats.bts.gov/PREZIP";

export function ontimeUrl(year, month) {
  return `${PREZIP}/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_${year}_${month}.zip`;
}

export function ontimeCachePath(year, month) {
  return `${CACHE_DIR}/ontime_reporting_carrier_${year}_${String(month).padStart(2, "0")}.zip`;
}

const MAX_ATTEMPTS = 8;

// BTS drops long connections now and then, so resume the partial file with a Range request.
async function downloadWithResume(url, partial) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const have = (await stat(partial).catch(() => null))?.size ?? 0;
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...(have > 0 ? { Range: `bytes=${have}-` } : {}) } });
      if (response.status === 416) return;
      if (!response.ok) fail(`download ${url} returned ${response.status}`);
      const resumed = response.status === 206;
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: resumed ? "a" : "w" }));
      return;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) fail(`download ${url} failed after ${MAX_ATTEMPTS} attempts: ${error.cause?.code ?? error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

export async function fetchOntimeMonth(year, month) {
  const target = ontimeCachePath(year, month);
  const cached = await stat(target).catch(() => null);
  if (cached) return { path: target, bytes: cached.size, fromCache: true };

  await mkdir(CACHE_DIR, { recursive: true });
  const partial = `${target}.part`;
  await downloadWithResume(ontimeUrl(year, month), partial);
  await rename(partial, target);
  return { path: target, bytes: (await stat(target)).size, fromCache: false };
}

export async function fetchOntimeYear(year, months = Array.from({ length: 12 }, (_, i) => i + 1)) {
  const results = [];
  for (const month of months) results.push(await fetchOntimeMonth(year, month));
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const year = Number(process.argv[2]);
  if (!Number.isInteger(year)) fail("usage: node fetch-ontime.mjs <year>");
  const months = process.argv[3]?.split(",").map(Number);
  const files = await fetchOntimeYear(year, months);
  console.log(`${files.length} files, ${(files.reduce((s, f) => s + f.bytes, 0) / 1e6).toFixed(1)} MB`);
}
