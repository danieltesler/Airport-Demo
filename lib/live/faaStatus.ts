/**
 * Live FAA airport delay / ground-stop / closure status.
 *
 * Source: FAA National Airspace System Status (nasstatus.faa.gov), the public XML feed
 * behind the FAA's own airport-status page. It is ONE national document listing only
 * the airports that currently have a program or delay, so we fetch it once (cached
 * 60 s) and filter locally. An airport that is not listed has no FAA-reported
 * program, which is what "no delays reported" means here.
 *
 * Note: the older ASWS endpoint (soa.smartcdn.faa.gov/asws/api/airport/status/<IATA>)
 * no longer resolves in DNS (verified 2026-10-18), hence this feed.
 */

import {
  LiveFetchError,
  TtlCache,
  fetchText,
  lookupAirport,
  nowOf,
  retrievedAtIso,
  safeReason,
  unavailable,
  type LiveDeps,
  type LiveTool,
  type LiveToolOutput,
} from "./common";

const SOURCE = "FAA National Airspace System Status (nasstatus.faa.gov)";
const FEED_URL = "https://nasstatus.faa.gov/api/airport-status-information";
const MAX_REASON_CHARS = 160;

export type FaaEventType = "ground_stop" | "ground_delay_program" | "arrival_departure_delay" | "closure";

export interface FaaEvent {
  type: FaaEventType;
  reason: string;
  detail: Record<string, string>;
}

export interface FaaFeed {
  updateTime: string | null;
  byAirport: Map<string, FaaEvent[]>;
  activeAirportCount: number;
}

const feedCache = new TtlCache<FaaFeed>(60_000, 2);

// --------------------------------------------------------------------------- //
// Parsing (the feed is small, regular XML; no XML dependency needed)
// --------------------------------------------------------------------------- //

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m]).trim();
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decode(m[1]) : null;
}

function classify(sectionName: string): FaaEventType | null {
  const name = sectionName.toLowerCase();
  if (name.includes("ground stop")) return "ground_stop";
  if (name.includes("ground delay")) return "ground_delay_program";
  if (name.includes("closure")) return "closure";
  if (name.includes("arrival") || name.includes("departure") || name.includes("delay")) {
    return "arrival_departure_delay";
  }
  return null; // e.g. airspace flow programs: not airport-specific
}

function truncate(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}...` : text;
}

function buildEvent(type: FaaEventType, item: string): FaaEvent {
  const detail: Record<string, string> = {};
  const put = (key: string, value: string | null) => {
    if (value) detail[key] = value;
  };
  if (type === "ground_stop") {
    put("end_time", tag(item, "End_Time"));
  } else if (type === "ground_delay_program") {
    put("average_delay", tag(item, "Avg"));
    put("max_delay", tag(item, "Max"));
  } else if (type === "arrival_departure_delay") {
    const kind = /<Arrival_Departure\s+Type="([^"]+)"/.exec(item)?.[1];
    put("applies_to", kind ? decode(kind).toLowerCase() : null);
    put("min_delay", tag(item, "Min"));
    put("max_delay", tag(item, "Max"));
    put("trend", tag(item, "Trend"));
  } else {
    put("start", tag(item, "Start"));
    put("reopen", tag(item, "Reopen"));
    // NOTAM wording: "CLSD TO NON SKED TRANSIENT GA ACFT" closes the airport to GA only, not to airlines.
    if (/NON[\s-]?SKED|\bGA\s+ACFT\b/i.test(tag(item, "Reason") ?? "")) {
      detail.scope = "limited to general-aviation / non-scheduled operations per NOTAM text (airlines not affected)";
    }
  }
  return { type, reason: truncate(tag(item, "Reason") ?? "not stated"), detail };
}

/** Parse the FAA NAS status XML into a per-airport event index. */
export function parseFaaFeed(xml: string): FaaFeed {
  if (!xml.includes("<AIRPORT_STATUS_INFORMATION")) {
    throw new LiveFetchError("upstream returned an unexpected document");
  }
  const byAirport = new Map<string, FaaEvent[]>();
  const sections = xml.match(/<Delay_type>[\s\S]*?<\/Delay_type>/g) ?? [];

  for (const section of sections) {
    const type = classify(tag(section, "Name") ?? "");
    if (!type) continue;
    const items = section.match(/<(Ground_Delay|Delay|Airport|Program)>[\s\S]*?<\/\1>/g) ?? [];
    for (const item of items) {
      const code = tag(item, "ARPT")?.toUpperCase();
      if (!code) continue;
      const events = byAirport.get(code) ?? [];
      events.push(buildEvent(type, item));
      byAirport.set(code, events);
    }
  }
  return { updateTime: tag(xml, "Update_Time"), byAirport, activeAirportCount: byAirport.size };
}

async function loadFeed(deps: LiveDeps): Promise<FaaFeed> {
  const nowMs = nowOf(deps).getTime();
  const cached = feedCache.get(FEED_URL, nowMs);
  if (cached) return cached;
  const feed = parseFaaFeed(await fetchText(FEED_URL, deps, { accept: "application/xml" }));
  feedCache.set(FEED_URL, feed, nowMs);
  return feed;
}

// --------------------------------------------------------------------------- //
// Tool
// --------------------------------------------------------------------------- //

export async function faaAirportStatus(args: Record<string, unknown>, deps: LiveDeps): Promise<LiveToolOutput> {
  const found = lookupAirport(args, deps);
  if (!found.ok) return found.output;
  const { airport } = found;

  let feed: FaaFeed;
  try {
    feed = await loadFeed(deps);
  } catch (err) {
    return unavailable(SOURCE, airport, safeReason(err));
  }

  const events = feed.byAirport.get(airport.iata) ?? [];
  const status = events.length === 0 ? "no_faa_program_reported" : "faa_program_reported";
  const rows = events.length
    ? events.map((e) => [e.type.replace(/_/g, " "), e.reason])
    : [["none", "No FAA ground stop, ground delay, delay or closure listed"]];

  return {
    result: {
      iata: airport.iata,
      name: airport.name,
      available: true,
      status,
      events,
      airports_with_active_programs_nationwide: feed.activeAirportCount,
      active_program_count_scope: "count of airports with an active FAA program anywhere in the FAA feed right now, not only the airports in the dataset",
      source: SOURCE,
      feed_updated: feed.updateTime,
      retrieved_at: retrievedAtIso(deps, [feedCache.storedAt(FEED_URL, nowOf(deps).getTime())]),
    },
    structured: { kind: "metric", columns: ["FAA status (now)", "Detail"], rows },
    assumptions: [
      "Live from the FAA National Airspace System Status feed at the moment you asked; it lists only airports with an active ground stop, ground delay program, general delay or closure.",
    ],
    uncertainty:
      "'No FAA program reported' is not 'no delays': airline-level or sub-threshold delays are not in this feed. " +
      "Closure entries are raw NOTAM-derived text, can be limited to general-aviation operations and can lag when lifted.",
  };
}

export const faaStatusTool: LiveTool = {
  name: "faa_airport_status",
  schema: {
    name: "faa_airport_status",
    description:
      "Live FAA operational status for one airport by IATA code: active ground stop, ground delay " +
      "program, arrival/departure delay (with reason) or closure, right now. Use ONLY for current " +
      "disruption / delay questions, not historical delay statistics or rankings.",
    input_schema: {
      type: "object",
      properties: { iata: { type: "string", description: "IATA code, e.g. 'JFK'." } },
      required: ["iata"],
    },
  },
  handler: faaAirportStatus,
};
