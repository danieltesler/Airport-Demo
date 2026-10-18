/**
 * Shared plumbing for the live public-API tools in lib/live/.
 *
 * Every live tool follows the same contract (mirrors lib/liveflights.ts, hardened):
 *   - input is an IATA code resolved against the bundled airport list; model text is
 *     NEVER interpolated into a URL
 *   - bounded timeout, bounded body size, short in-memory TTL cache
 *   - failures become `available:false` results with a safe, generic message
 *     (no URLs, no keys, no raw upstream bodies)
 *   - results are SMALL aggregates carrying source, retrieval time and limitations
 *
 * This module deliberately does not import lib/data.ts or lib/tools.ts: airport
 * resolution is injected (see LiveDeps) so the tools stay decoupled and testable.
 */

import { roundTo } from "../rounding";
import type { StructuredResult } from "../types";

/** The minimum airport facts the live tools need. Structurally satisfied by data.Airport. */
export interface AirportRef {
  iata: string;
  icao: string;
  name: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
  /** Bundled-dataset passenger figure, when known; lets live tools state how they relate to it. */
  annual_passengers?: number;
}

export interface LiveDeps {
  /** Resolve a validated IATA code against the airport list; undefined if unknown. */
  resolveAirport: (iata: string) => AirportRef | undefined;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Human-readable vintage of the bundled dataset, for labelling comparisons. */
  datasetVintage?: string;
}

/** Structurally identical to ToolOutput in lib/tools.ts. */
export interface LiveToolOutput {
  result: Record<string, unknown>;
  structured?: StructuredResult | null;
  assumptions?: string[];
  uncertainty?: string | null;
}

export interface LiveToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LiveTool {
  name: string;
  schema: LiveToolSchema;
  handler: (args: Record<string, unknown>, deps: LiveDeps) => Promise<LiveToolOutput>;
}

// A descriptive User-Agent is a courtesy to the public APIs: it says who is calling.
export const USER_AGENT =
  "airport-investment-intelligence (https://github.com/danieltesler/Airport-Demo)";

export const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BODY_CHARS = 2_000_000;

/** Raised for any upstream failure. The message is safe to show the model. */
export class LiveFetchError extends Error {}

// --------------------------------------------------------------------------- //
// TTL cache
// --------------------------------------------------------------------------- //

const ALL_CACHES: TtlCache<unknown>[] = [];

export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number; storedAt: number }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 200) {
    ALL_CACHES.push(this as TtlCache<unknown>);
  }

  get(key: string, nowMs: number): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= nowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, nowMs: number): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: nowMs + this.ttlMs, storedAt: nowMs });
  }

  /** When the cached value was fetched (ms since epoch), so a cached answer reports its real retrieval time. */
  storedAt(key: string, nowMs: number): number | undefined {
    const hit = this.entries.get(key);
    return hit && hit.expires > nowMs ? hit.storedAt : undefined;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Test helper: drop every live-tool cache. */
export function clearLiveCaches(): void {
  for (const cache of ALL_CACHES) cache.clear();
}

// --------------------------------------------------------------------------- //
// HTTP
// --------------------------------------------------------------------------- //

export interface FetchOptions {
  timeoutMs?: number;
  accept?: string;
}

/**
 * Read a response body without buffering more than MAX_BODY_CHARS: the stream is cancelled as
 * soon as it passes the cap, so an oversized or endless upstream cannot fill memory first.
 */
async function readBodyCapped(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (text.length > MAX_BODY_CHARS) throw new LiveFetchError("upstream response too large");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > MAX_BODY_CHARS) {
      await reader.cancel().catch(() => undefined);
      throw new LiveFetchError("upstream response too large");
    }
  }
  return text + decoder.decode();
}

/**
 * GET a URL and return the body text. Throws LiveFetchError with a generic message
 * (never the URL: some URLs carry API keys).
 */
export async function fetchText(
  url: string,
  deps: Pick<LiveDeps, "fetchImpl">,
  options: FetchOptions = {},
): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await doFetch(url, {
      headers: { Accept: options.accept ?? "application/json", "User-Agent": USER_AGENT },
      signal: controller.signal,
      redirect: "manual", // a redirect (e.g. Census "missing key") is a failure, not content
    });
    if (response.status >= 300 && response.status < 400) {
      throw new LiveFetchError(`upstream redirected (HTTP ${response.status}), likely a key or access policy`);
    }
    if (!response.ok) throw new LiveFetchError(`upstream returned HTTP ${response.status}`);
    return await readBodyCapped(response);
  } catch (err) {
    if (err instanceof LiveFetchError) throw err;
    if ((err as Error)?.name === "AbortError") throw new LiveFetchError("upstream timed out");
    throw new LiveFetchError("upstream unreachable");
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(
  url: string,
  deps: Pick<LiveDeps, "fetchImpl">,
  options: FetchOptions = {},
): Promise<unknown> {
  const body = await fetchText(url, deps, options);
  if (body.trim() === "") return null; // e.g. HTTP 200/204 with no content
  try {
    return JSON.parse(body);
  } catch {
    throw new LiveFetchError("upstream returned malformed JSON");
  }
}

// --------------------------------------------------------------------------- //
// Input + output helpers
// --------------------------------------------------------------------------- //

/** Strict 3-letter IATA shape check. Returns the upper-cased code or null. */
export function normalizeIata(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

export type AirportLookup =
  | { ok: true; airport: AirportRef }
  | { ok: false; output: LiveToolOutput };

/** Validate + resolve the airport argument; on failure returns a ready-made error output. */
export function lookupAirport(args: Record<string, unknown>, deps: LiveDeps): AirportLookup {
  const iata = normalizeIata(args.iata);
  if (!iata) {
    return { ok: false, output: { result: { error: "Provide a 3-letter IATA airport code, e.g. 'BOS'." } } };
  }
  const airport = deps.resolveAirport(iata);
  if (!airport) {
    return { ok: false, output: { result: { error: `'${iata}' is not in the dataset.` } } };
  }
  return { ok: true, airport };
}

/**
 * The retrieval time to report: the oldest fetch time among the cached values the answer used,
 * or now when none is known. A value served from cache was fetched earlier than "now".
 */
export function retrievedAtIso(deps: Pick<LiveDeps, "now">, stamps: (number | undefined)[]): string {
  const known = stamps.filter((stamp): stamp is number => stamp !== undefined);
  return known.length > 0 ? new Date(Math.min(...known)).toISOString() : nowOf(deps).toISOString();
}

export function nowOf(deps: Pick<LiveDeps, "now">): Date {
  return (deps.now ?? (() => new Date()))();
}

/** Standard "source unavailable" result: says what failed, leaks nothing. */
export function unavailable(
  source: string,
  airport: Pick<AirportRef, "iata">,
  reason: string,
  options: { fallback?: string; message?: string } = {},
): LiveToolOutput {
  return {
    result: {
      iata: airport.iata,
      available: false,
      do_not_estimate: true,
      source,
      message: options.message ?? `Could not retrieve live data from ${source}: ${reason}. No figures are available for this question right now.`,
      fallback:
        options.fallback ??
        "Tell the user this live source is unavailable right now. If the bundled dataset has a relevant figure, " +
          "offer it clearly labelled as the dataset snapshot. Do not estimate or invent live values.",
    },
  };
}

export function safeReason(err: unknown): string {
  return err instanceof LiveFetchError ? err.message : "unexpected response format";
}

export const toNumber = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

export const round = roundTo;
