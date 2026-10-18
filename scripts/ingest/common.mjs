// Shared paths and small helpers for the staging ingestion pipeline.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CACHE_DIR = `${ROOT}data/.cache`;
export const MANUAL_DIR = `${CACHE_DIR}/manual`;
export const STAGING_DIR = `${ROOT}data/staging`;
export const USER_AGENT = "Mozilla/5.0 (compatible; AirportDemoIngest/1.0; staging data build)";

export function sha256OfFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export function fail(message) {
  console.error(`FAILED: ${message}`);
  process.exit(1);
}
