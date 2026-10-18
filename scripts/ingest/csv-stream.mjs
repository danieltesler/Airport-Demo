// Streams CSV rows out of a zip without extracting it to disk or holding it in memory.
// Windows ships bsdtar (reads zips); elsewhere we use `unzip -p`.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export function splitCsvLine(line, delimiter = ",") {
  if (!line.includes('"')) return line.split(delimiter);
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes && ch === '"' && line[i + 1] === '"') {
      current += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function spawnZipReader(zipPath) {
  if (process.platform === "win32") {
    const tar = `${process.env.SystemRoot ?? "C:/Windows"}/System32/tar.exe`;
    return spawn(tar, ["-xOf", zipPath], { stdio: ["ignore", "pipe", "pipe"] });
  }
  return spawn("unzip", ["-p", zipPath], { stdio: ["ignore", "pipe", "pipe"] });
}

async function* rowsFromLines(lines, delimiter) {
  let header = null;
  for await (const line of lines) {
    if (!line) continue;
    const cells = splitCsvLine(line, delimiter);
    if (!header) {
      header = cells.map((h) => h.replace(/^\uFEFF/, "").trim());
      continue;
    }
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i];
    yield row;
  }
}

/** Yields one object per data row, keyed by the header. Throws if the reader exits non-zero. */
export async function* readZippedCsv(zipPath, delimiter = ",") {
  const child = spawnZipReader(zipPath);
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on("close", resolve));
  yield* rowsFromLines(createInterface({ input: child.stdout, crlfDelay: Infinity }), delimiter);
  const code = await exited;
  if (code !== 0) throw new Error(`zip reader failed for ${zipPath}: ${stderr.slice(0, 200)}`);
}

export async function* readCsvFile(path, delimiter = ",") {
  yield* rowsFromLines(createInterface({ input: createReadStream(path), crlfDelay: Infinity }), delimiter);
}
