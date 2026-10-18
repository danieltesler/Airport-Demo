/**
 * Live airport infrastructure from the USDOT NTAD / FAA airport data (ArcGIS REST).
 *
 * Sources (public ArcGIS feature services, no key), both derived from the FAA's
 * airport master record (Form 5010):
 *   - NTAD_Aviation_Facilities : tower type, Part 139 class, elevation, acreage, status
 *   - Runways_View             : one row per runway (length, width, surface, condition)
 *
 * Capacity infrastructure (runways, longest runway, tower, Part 139 certification)
 * is directly relevant to expansion questions. Facility is matched on the airport's
 * ICAO id (taken from the bundled list), then runways on the FAA airport id that the
 * facility record returns; both are shape-checked before reaching a URL.
 */

import {
  LiveFetchError,
  TtlCache,
  fetchJson,
  lookupAirport,
  nowOf,
  retrievedAtIso,
  safeReason,
  toNumber,
  unavailable,
  type LiveDeps,
  type LiveTool,
  type LiveToolOutput,
} from "./common";

const SOURCE = "USDOT NTAD / FAA airport master record (services.arcgis.com, Aviation Facilities + Runways)";
const ARCGIS = "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services";
const FACILITY_URL = `${ARCGIS}/NTAD_Aviation_Facilities/FeatureServer/0/query`;
const RUNWAY_URL = `${ARCGIS}/Runways_View/FeatureServer/0/query`;
const MAX_RUNWAYS_LISTED = 12;

interface Facility {
  faaId: string;
  towerType: string | null;
  part139Class: string | null;
  elevationFt: number | null;
  acres: number | null;
  status: string | null;
  recordEffective: string | null;
}

interface Runway {
  id: string;
  lengthFt: number | null;
  widthFt: number | null;
  surface: string | null;
  condition: string | null;
}

interface Infrastructure {
  facility: Facility;
  runways: Runway[];
}

const cache = new TtlCache<Infrastructure>(24 * 60 * 60 * 1000); // FAA record changes on a 28-day cycle

// --------------------------------------------------------------------------- //
// Parsing
// --------------------------------------------------------------------------- //

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function attributesOf(body: unknown): Record<string, unknown>[] {
  const features = (body as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) throw new LiveFetchError("upstream returned an unexpected shape");
  return features
    .map((f) => (f as { attributes?: Record<string, unknown> }).attributes)
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object");
}

export function parseFacility(body: unknown): Facility | null {
  const a = attributesOf(body)[0];
  const faaId = str(a?.ARPT_ID)?.toUpperCase();
  if (!a || !faaId) return null;
  return {
    faaId,
    towerType: str(a.TWR_TYPE_CODE),
    part139Class: str(a.FAR_139_TYPE_CODE),
    elevationFt: toNumber(a.ELEV),
    acres: toNumber(a.ACREAGE),
    status: str(a.ARPT_STATUS),
    recordEffective: str(a.EFF_DATE),
  };
}

export function parseRunways(body: unknown): Runway[] {
  return attributesOf(body)
    .map((a) => ({
      id: str(a.RWY_ID) ?? "?",
      lengthFt: toNumber(a.RWY_LEN),
      widthFt: toNumber(a.RWY_WIDTH),
      surface: str(a.SURFACE_TYPE_CODE),
      condition: str(a.COND),
    }))
    .sort((x, y) => (y.lengthFt ?? 0) - (x.lengthFt ?? 0));
}

// --------------------------------------------------------------------------- //
// Fetch
// --------------------------------------------------------------------------- //

function queryUrl(base: string, where: string, fields: string[]): string {
  const params = new URLSearchParams({ where, outFields: fields.join(","), returnGeometry: "false", f: "json" });
  return `${base}?${params.toString()}`;
}

async function loadInfrastructure(icao: string, deps: LiveDeps): Promise<Infrastructure | null> {
  const nowMs = nowOf(deps).getTime();
  const cached = cache.get(icao, nowMs);
  if (cached) return cached;

  if (!/^[A-Z0-9]{4}$/.test(icao)) throw new Error("invalid airport id");
  const facilityBody = await fetchJson(
    queryUrl(FACILITY_URL, `ICAO_ID='${icao}'`, [
      "ARPT_ID", "TWR_TYPE_CODE", "FAR_139_TYPE_CODE", "ELEV", "ACREAGE", "ARPT_STATUS", "EFF_DATE",
    ]),
    deps,
  );
  const facility = parseFacility(facilityBody);
  if (!facility) return null;

  if (!/^[A-Z0-9]{3,4}$/.test(facility.faaId)) throw new Error("invalid airport id");
  const runwayBody = await fetchJson(
    queryUrl(RUNWAY_URL, `ARPT_ID='${facility.faaId}'`, ["RWY_ID", "RWY_LEN", "RWY_WIDTH", "SURFACE_TYPE_CODE", "COND"]),
    deps,
  );
  const result = { facility, runways: parseRunways(runwayBody) };
  cache.set(icao, result, nowMs);
  return result;
}

// --------------------------------------------------------------------------- //
// Tool
// --------------------------------------------------------------------------- //

export async function faaAirportInfrastructure(args: Record<string, unknown>, deps: LiveDeps): Promise<LiveToolOutput> {
  const found = lookupAirport(args, deps);
  if (!found.ok) return found.output;
  const { airport } = found;

  let infra: Infrastructure | null;
  try {
    infra = await loadInfrastructure(airport.icao.toUpperCase(), deps);
  } catch (err) {
    return unavailable(SOURCE, airport, safeReason(err));
  }
  if (!infra) return unavailable(SOURCE, airport, `no FAA airport record found for ${airport.icao}`);

  const { facility, runways } = infra;
  const lengths = runways.map((r) => r.lengthFt).filter((n): n is number => n !== null);
  const longest = lengths.length ? Math.max(...lengths) : null;

  return {
    result: {
      iata: airport.iata,
      name: airport.name,
      available: true,
      faa_id: facility.faaId,
      runway_count: runways.length,
      longest_runway_ft: longest,
      runways: runways.slice(0, MAX_RUNWAYS_LISTED).map((r) => ({
        id: r.id,
        length_ft: r.lengthFt,
        width_ft: r.widthFt,
        surface: r.surface,
        condition: r.condition,
      })),
      control_tower_type: facility.towerType,
      part_139_class: facility.part139Class,
      elevation_ft: facility.elevationFt,
      acres: facility.acres,
      operational_status: facility.status,
      faa_record_effective: facility.recordEffective,
      source: SOURCE,
      retrieved_at: retrievedAtIso(deps, [cache.storedAt(airport.icao.toUpperCase(), nowOf(deps).getTime())]),
    },
    structured: {
      kind: "metric",
      columns: ["FAA infrastructure", "Value"],
      rows: [
        ["Runways", runways.length],
        ["Longest runway (ft)", longest ?? "n/a"],
        ["Control tower", facility.towerType ?? "n/a"],
        ["Part 139 class", facility.part139Class ?? "n/a"],
        ["Acres", facility.acres ?? "n/a"],
      ],
    },
    assumptions: [
      "Runway and facility facts are read live from the FAA airport master record published through USDOT's NTAD ArcGIS services.",
      "Runway count is the number of runway surfaces in that record; each runway counts once even though it has two ends.",
    ],
    uncertainty:
      "This is physical infrastructure only: it does not show terminal or gate capacity, and the record updates on the FAA's " +
      "28-day cycle. The count can differ from other datasets (for example OurAirports) that treat closed or short runways differently.",
  };
}

export const faaInfrastructureTool: LiveTool = {
  name: "faa_airport_infrastructure",
  schema: {
    name: "faa_airport_infrastructure",
    description:
      "FAA runway and facility record for one airport by IATA code, queried live: runway count and " +
      "lengths, longest runway, control-tower type, Part 139 certification class, acreage. Use for " +
      "questions about physical runway capacity or airfield facilities.",
    input_schema: {
      type: "object",
      properties: { iata: { type: "string", description: "IATA code, e.g. 'ORD'." } },
      required: ["iata"],
    },
  },
  handler: faaAirportInfrastructure,
};
