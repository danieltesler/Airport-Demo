/**
 * Data-driven geography: turns scope text ("New England", "Pacific", "LA", "near
 * Boston", "within 100 miles of JFK", "CA", "BOS") into a set of airports.
 *
 * Nothing here lists airports. Membership is always DERIVED:
 *  - state / Census division / Census region: from each airport's state code and the
 *    published U.S. Census Bureau definitions in data/geography.json.
 *  - metro alias, "near <place>", "within N miles of <place>": great-circle distance
 *    from a center point to each airport's lat/lon.
 *  - optional `metro` / `metro_code` on an airport (the Census CBSA title and code that
 *    contain it): matched by title, title without states, "<principal city> metro", or code.
 *
 * Adding airports needs no code change. Adding an area is one row in
 * data/geography.json (metro_aliases). The gazetteer (place name -> coordinates) is the
 * caller's `places` list (the app passes the Census Gazetteer, data/places.json) plus the
 * airports' own cities.
 *
 * Pure module: no I/O, no dependency on the bundled airport dataset.
 */

import geography from "@/data/geography.json";

export interface GeoAirport {
  iata: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
  /** Optional metro title (the Census CBSA title, e.g. "Boston-Cambridge-Newton, MA-NH"). */
  metro?: string;
  /** Optional metro code (the Census CBSA code, e.g. "14460"). */
  metro_code?: string;
}

export interface Place {
  name: string;
  state: string;
  lat: number;
  lon: number;
  /** Census population estimate; used only to settle a name shared by places of very different size. */
  population?: number;
}

export interface MetroAlias {
  /** Spellings that select this area; the first is the display/suggestion form. */
  names: string[];
  label: string;
  center: { lat: number; lon: number };
  radius_miles: number;
  /**
   * Bare names this area shares with a U.S. state ("New York"). Such a name is ambiguous between
   * the state and this area, so it is offered as a choice instead of silently meaning the state.
   */
  ambiguous_names?: string[];
}

export type ResolvedAs = "all" | "airport" | "metro" | "state" | "census_division" | "census_region" | "informal_region" | "radius";

export interface ScopeOption {
  label: string;
  /** Scope text that resolves unambiguously; safe to pass back into resolveScope. */
  scope: string;
}

export type ScopeStatus = "matched" | "empty" | "ambiguous" | "unknown";

export interface ScopeResolution<T extends GeoAirport = GeoAirport> {
  status: ScopeStatus;
  input: string;
  /** How the scope was understood; null when it was not (ambiguous / unknown). */
  resolvedAs: ResolvedAs | null;
  /** For an informal region: its member states, e.g. "CA, OR, WA", shown in the caption. */
  detail?: string;
  label: string;
  airports: T[];
  notes: string[];
  /** True when the text was simplified to be understood (extra wording ignored). */
  reinterpreted?: boolean;
  /** Present when status is "ambiguous". */
  options?: ScopeOption[];
  /** Present when status is "unknown" or "empty": closest supported scopes. */
  suggestions?: string[];
}

export interface GeographyOptions {
  /** Gazetteer rows (e.g. the Census Gazetteer); take precedence over the airports' own cities. */
  places?: Place[];
  /** Extra metro aliases; take precedence over the bundled ones. */
  metroAliases?: MetroAlias[];
}

export const DEFAULT_RADIUS_MILES = 50;
/**
 * A place name shared by several places resolves to the most populous one only when it has at
 * least this many times the population of the next ("Dallas": TX, not OR or GA). Closer calls
 * ("Portland": OR vs ME, about 9x) stay ambiguous and are asked about.
 */
export const DOMINANT_PLACE_POPULATION_RATIO = 10;
/** A city sharing a state's name makes that name ambiguous only from this population up. */
export const STATE_NAME_CITY_MIN_POPULATION = 100_000;
export const MAX_RADIUS_MILES = 1000;
const EARTH_RADIUS_MILES = 3958.8;
const KM_PER_MILE = 1.609344;

// --------------------------------------------------------------------------- //
// Static tables (data/geography.json)
// --------------------------------------------------------------------------- //

interface Region { id: string; name: string; aliases: string[] }
interface Division { id: string; name: string; region: string; aliases: string[] }
/** An informal region (West Coast, Gulf Coast, ...) defined as an explicit list of states, with its definition stated. */
interface StateSetAlias { names: string[]; label: string; states: string[]; note: string; contested: boolean }
interface StateRow { code: string; name: string; division: string | null }

const REGIONS = geography.regions as Region[];
const DIVISIONS = geography.divisions as Division[];
const STATES = geography.states as StateRow[];
const BUNDLED_ALIASES = geography.metro_aliases as MetroAlias[];
const STATE_SETS = geography.state_set_aliases as StateSetAlias[];

const STATE_BY_CODE = new Map(STATES.map((s) => [s.code, s]));
const DIVISION_BY_ID = new Map(DIVISIONS.map((d) => [d.id, d]));

/** Source line for docs and UI footnotes. */
export const GEOGRAPHY_SOURCES: string[] = geography.meta.sources;

/** Words too common to count as a match when suggesting areas. */
const STOP_WORDS = new Set(["the", "area", "region", "states", "state", "airport", "airports", "near", "and", "of"]);

const ALL_SCOPE_WORDS = new Set([
  "all", "all airports", "everywhere", "nationwide", "national", "us", "usa", "united states",
]);

/** The scope kinds the resolver supports, in resolution order. Shown to the model on failure. */
export const SUPPORTED_SCOPE_KINDS: string[] = [
  "'all'",
  "an airport code present in the dataset",
  "a named metro alias",
  "a U.S. state or territory (name or postal code)",
  "a U.S. Census division (e.g. New England, Pacific, Mountain)",
  "a U.S. Census region (Northeast, Midwest, South, West)",
  "an informal region with a stated definition (West Coast, East Coast, Gulf Coast, Pacific Northwest, Southwest, Sun Belt, ...)",
  "'near <city or airport code>' (default 50 miles)",
  "'within N miles of <city or airport code>'",
];

// --------------------------------------------------------------------------- //
// Pure helpers
// --------------------------------------------------------------------------- //

/** Great-circle distance in miles between two lat/lon points. */
export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Lowercase, drop periods, turn separators into spaces, drop a leading "the". */
export function normalizeScope(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "") // diacritics: "San José" -> "San Jose"
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[,_\-/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?!;:]+$/, "") // trailing punctuation: "Texas?"
    .trim()
    .replace(/^the /, "");
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}

const roundMiles = (miles: number): number => Math.round(miles);

function placeLabel(place: Place): string {
  return `${place.name}, ${place.state}`;
}

// --------------------------------------------------------------------------- //
// Gazetteer
// --------------------------------------------------------------------------- //

type PlaceIndex = Map<string, Place[]>;

/**
 * Index places by normalized name. Priority on duplicates (same name + state):
 * caller-supplied, then the airports' own cities. An airport city such as
 * "Providence/Warwick" or "Honolulu, Oahu" is also indexed under each part.
 */
function buildPlaceIndex(airports: GeoAirport[], extra: Place[]): PlaceIndex {
  const index: PlaceIndex = new Map();
  const seen = new Set<string>();
  const add = (place: Place, name: string): void => {
    const key = normalizeScope(name);
    const identity = `${key}|${place.state}`;
    if (!key || seen.has(identity)) return;
    seen.add(identity);
    index.set(key, [...(index.get(key) ?? []), place]);
  };
  for (const place of extra) add(place, place.name);
  for (const airport of airports) {
    const place = { name: airport.city, state: airport.state, lat: airport.lat, lon: airport.lon };
    add(place, airport.city);
    for (const part of airport.city.split(/[/,]/)) add({ ...place, name: part.trim() }, part);
  }
  return index;
}

/**
 * Settle a name shared by several places by population, but only when one clearly dominates
 * (DOMINANT_PLACE_POPULATION_RATIO). Without a population for every candidate, nothing is settled.
 */
function preferDominantPlace(places: Place[]): Place[] {
  if (places.length < 2 || places.some((p) => !(p.population && p.population > 0))) return places;
  const [largest, next] = [...places].sort((a, b) => b.population! - a.population!);
  return largest.population! >= DOMINANT_PLACE_POPULATION_RATIO * next.population! ? [largest] : places;
}

/** Find places by name, optionally qualified by a trailing state ("portland or", "portland oregon"). */
function findPlaces(text: string, index: PlaceIndex): Place[] {
  const exact = index.get(text);
  if (exact) return preferDominantPlace(exact);
  for (const state of STATES) {
    for (const suffix of [state.code.toLowerCase(), normalizeScope(state.name)]) {
      if (!text.endsWith(` ${suffix}`)) continue;
      const base = text.slice(0, text.length - suffix.length - 1).trim();
      const matches = (index.get(base) ?? []).filter((p) => p.state === state.code);
      if (matches.length > 0) return matches;
    }
  }
  return [];
}

// --------------------------------------------------------------------------- //
// Resolver
// --------------------------------------------------------------------------- //

interface RadiusRequest {
  anchorText: string;
  radiusMiles: number;
  explicitRadius: boolean;
}

const UNIT = "(mi|miles?|km|kilometers?|kilometres?)";
const NUMBER = "(\\d+(?:\\.\\d+)?)";
const WITHIN_PATTERN = new RegExp(`^(?:within|inside|up to)\\s+${NUMBER}\\s*${UNIT}?\\s+(?:radius\\s+)?(?:of|from|around)\\s+(.+)$`);
const DISTANCE_PATTERN = new RegExp(`^${NUMBER}\\s*${UNIT}\\s+(?:radius\\s+)?(?:of|from|around)\\s+(.+)$`);
const NEAR_PATTERN = /^(?:near|around|close to|nearby|by)\s+(.+)$/;

/** "near me", "close to us", "near here": the user's own location, which the app never knows. */
export const SELF_LOCATION = /^(?:me|us|here|my (?:location|area|place|city|home)|where i am|where we are|my current location)$/i;
export const ASK_FOR_LOCATION_NOTE = "The user did not name a place; ask which city or airport to measure from.";

function parseRadiusRequest(text: string): RadiusRequest | null {
  const explicit = text.match(WITHIN_PATTERN) ?? text.match(DISTANCE_PATTERN);
  if (explicit) {
    const unit = explicit[2] ?? "mi";
    const amount = Number(explicit[1]);
    const radiusMiles = unit.startsWith("k") ? amount / KM_PER_MILE : amount;
    return { anchorText: explicit[3], radiusMiles, explicitRadius: true };
  }
  const near = text.match(NEAR_PATTERN);
  return near ? { anchorText: near[1], radiusMiles: DEFAULT_RADIUS_MILES, explicitRadius: false } : null;
}

/**
 * Spellings that select an airport's metro field: the CBSA title, the title without its
 * states, "<first principal city> metro" / "metro area" / "metropolitan area", and the code.
 */
function metroKeys(airport: GeoAirport): string[] {
  if (!airport.metro) return [];
  const beforeStates = airport.metro.split(",")[0];
  const firstCity = normalizeScope(beforeStates.split("-")[0]);
  const keys = [
    normalizeScope(airport.metro),
    normalizeScope(beforeStates),
    `${firstCity} metro`,
    `${firstCity} metro area`,
    `${firstCity} metropolitan area`,
  ];
  if (airport.metro_code) keys.push(airport.metro_code);
  return keys;
}

function matchedResult<T extends GeoAirport>(
  input: string,
  resolvedAs: ResolvedAs,
  label: string,
  airports: T[],
  notes: string[] = [],
): ScopeResolution<T> {
  return { status: airports.length > 0 ? "matched" : "empty", input, resolvedAs, label, airports, notes };
}

class ScopeResolver<T extends GeoAirport> {
  private readonly aliases: MetroAlias[];
  private readonly placeIndex: PlaceIndex;
  private readonly airportByCode: Map<string, T>;

  constructor(
    private readonly airports: T[],
    options: GeographyOptions,
  ) {
    this.aliases = [...(options.metroAliases ?? []), ...BUNDLED_ALIASES];
    this.placeIndex = buildPlaceIndex(airports, options.places ?? []);
    this.airportByCode = new Map(airports.map((a) => [a.iata.toUpperCase(), a]));
  }

  resolve(rawInput: string | null | undefined): ScopeResolution<T> {
    const input = (rawInput ?? "").trim();
    const text = normalizeScope(input);
    if (!text || ALL_SCOPE_WORDS.has(text)) {
      return matchedResult(input, "all", "all airports", this.airports);
    }

    const direct =
      this.resolveAirportCode(input, text) ?? this.resolveMetroAlias(input, text) ?? this.resolveMetroField(input, text);
    if (direct) return direct;

    // An unrecognized radius request ("near Boston area") does not end the search: the named-area
    // and trimmed-phrase readings still get a turn, and the radius's own explanation is the fallback.
    const radius = this.resolveRadiusRequest(input, text);
    if (radius && radius.status !== "unknown") return radius;
    return (
      this.resolveNamedArea(input, text) ??
      this.resolveExplicitState(input, text) ??
      this.resolveTrimmedPhrase(input, text) ??
      radius ??
      this.unknown(input, text)
    );
  }

  /**
   * "New York state" and "upstate New York" name the state outright, which settles a name that is
   * otherwise ambiguous with a city area. The word 'upstate' is not a boundary the dataset knows,
   * so the note says every airport in the state is included.
   */
  private resolveExplicitState(input: string, text: string): ScopeResolution<T> | null {
    const match = text.match(/^(upstate )?(.+?)( state)?$/);
    if (!match || (!match[1] && !match[3])) return null;
    const state = this.findState(match[2]);
    if (!state) return null;
    const result = this.stateResult(input, state);
    if (!match[1]) return result;
    return {
      ...result,
      reinterpreted: true,
      notes: [...result.notes, `'upstate' is not a boundary in the data: every airport in ${state.name} is included, downstate ones too.`],
    };
  }

  /**
   * Last resort for natural phrasing: "Northeast US", "Texas area", or "Northeast
   * including New York and New Jersey". Retries on the leading phrase and says what was
   * dropped, so the caller can see the scope was read more simply than it was worded.
   */
  private resolveTrimmedPhrase(input: string, text: string): ScopeResolution<T> | null {
    const head = text.split(/ (?:including|plus|with|especially) /)[0];
    const trimmed = head.replace(/ (?:us|usa|area|region|states|airports?)$/, "");
    if (trimmed === text || !trimmed) return null;
    const retried = this.resolve(trimmed);
    if (retried.status === "unknown") return null;
    return {
      ...retried,
      input,
      reinterpreted: true,
      notes: [...retried.notes, `The scope '${input}' was read as '${trimmed}'; the rest of the wording was ignored.`],
    };
  }

  private resolveAirportCode(input: string, text: string): ScopeResolution<T> | null {
    const airport = text.length === 3 ? this.airportByCode.get(text.toUpperCase()) : undefined;
    if (!airport) return null;
    return matchedResult(input, "airport", `${airport.iata} (${airport.city})`, [airport]);
  }

  private findAlias(text: string): MetroAlias | undefined {
    return this.aliases.find((alias) => alias.names.some((name) => normalizeScope(name) === text));
  }

  private resolveMetroAlias(input: string, text: string): ScopeResolution<T> | null {
    const alias = this.findAlias(text);
    if (!alias) return null;
    const airports = this.withinRadius(alias.center, alias.radius_miles);
    const notes = [
      `Metro alias defined as data: ${roundMiles(alias.radius_miles)} mi around (${alias.center.lat}, ${alias.center.lon}).`,
    ];
    const stateCode = text.toUpperCase();
    if (STATE_BY_CODE.has(stateCode)) {
      notes.push(
        `'${input}' is also the postal code for ${STATE_BY_CODE.get(stateCode)!.name}; it was read as this ` +
          `metro alias. Use the state's full name to scope to the state.`,
      );
    }
    return matchedResult(input, "metro", alias.label, airports, notes);
  }

  private resolveMetroField(input: string, text: string): ScopeResolution<T> | null {
    const titles = [...new Set(this.airports.filter((a) => metroKeys(a).includes(text)).map((a) => a.metro!))];
    if (titles.length === 0) return null;
    if (titles.length > 1) {
      return this.ambiguous(
        input,
        `'${input}' matches more than one metro area.`,
        titles.map((title) => ({ label: `${title} (metro area)`, scope: title })),
      );
    }
    const members = this.airports.filter((a) => a.metro === titles[0]);
    const code = members[0].metro_code ? ` (CBSA ${members[0].metro_code})` : "";
    return matchedResult(input, "metro", titles[0], members, [
      `Matched on the Census metropolitan or micropolitan statistical area${code} that contains each airport.`,
    ]);
  }

  private resolveRadiusRequest(input: string, text: string): ScopeResolution<T> | null {
    const request = parseRadiusRequest(text);
    if (!request) return null;
    if (!(request.radiusMiles > 0) || request.radiusMiles > MAX_RADIUS_MILES) {
      return {
        status: "unknown",
        input,
        resolvedAs: null,
        label: input,
        airports: [],
        notes: [`The radius must be greater than 0 and at most ${MAX_RADIUS_MILES} miles.`],
        suggestions: [],
      };
    }
    return this.resolveAround(input, request.anchorText, request.radiusMiles, request.explicitRadius);
  }

  /**
   * Radius search around an airport code, a metro alias center, or a place name. A trailing
   * "airport(s)" or "area" is dropped when the words as typed are not recognized ("near JFK airport",
   * "near Boston area"); it is tried second so "near Bay Area" still finds the Bay Area alias.
   */
  private resolveAround(
    input: string,
    anchorText: string,
    radiusMiles: number,
    explicitRadius: boolean,
  ): ScopeResolution<T> | null {
    const first = this.resolveAroundAnchor(input, anchorText, radiusMiles, explicitRadius);
    if (first?.status !== "unknown") return first;
    const stripped = normalizeScope(anchorText).replace(/ (?:airports?|area)$/, "");
    if (stripped === normalizeScope(anchorText) || !stripped) return first;
    const second = this.resolveAroundAnchor(input, stripped, radiusMiles, explicitRadius);
    return second && second.status !== "unknown" ? second : first;
  }

  private resolveAroundAnchor(
    input: string,
    anchorText: string,
    radiusMiles: number,
    explicitRadius: boolean,
  ): ScopeResolution<T> | null {
    const anchor = normalizeScope(anchorText);
    const radius = roundMiles(radiusMiles);
    const scopePrefix = explicitRadius ? `within ${radius} miles of` : "near";

    // "near me" once fuzzy-matched "me" to MEM, MKE, CLE and CMH. The app has no location: ask, suggest nothing.
    if (SELF_LOCATION.test(anchor)) {
      return { ...this.unknown(input, anchor, [ASK_FOR_LOCATION_NOTE]), suggestions: [] };
    }

    const airport = anchor.length === 3 ? this.airportByCode.get(anchor.toUpperCase()) : undefined;
    if (airport) {
      return this.radiusResult(input, `${radius} mi around ${airport.iata}`, airport, radiusMiles, explicitRadius, [
        `Centered on the coordinates of airport ${airport.iata}; that airport is included.`,
      ]);
    }

    const alias = this.findAlias(anchor);
    if (alias) {
      return this.radiusResult(input, `${radius} mi around ${alias.label}`, alias.center, radiusMiles, explicitRadius, []);
    }

    const places = findPlaces(anchor, this.placeIndex);
    if (places.length === 1) {
      const place = places[0];
      return this.radiusResult(input, `${radius} mi around ${placeLabel(place)}`, place, radiusMiles, explicitRadius, [
        `Place coordinates come from the Census Gazetteer or the dataset's own airport cities.`,
      ]);
    }
    if (places.length > 1) {
      return this.ambiguous(
        input,
        `'${anchorText}' matches more than one place.`,
        places.map((p) => ({ label: placeLabel(p), scope: `${scopePrefix} ${placeLabel(p)}` })),
      );
    }
    return this.unknown(input, anchor, [
      `Could not find a city or airport code named '${anchorText}' to measure distance from.`,
    ]);
  }

  private resolveNamedArea(input: string, text: string): ScopeResolution<T> | null {
    const interpretations: Array<{ option: ScopeOption; resolve: () => ScopeResolution<T> }> = [];

    const state = this.findState(text);
    if (state) {
      interpretations.push({
        option: { label: `${state.name} (state)`, scope: state.code },
        resolve: () => this.stateResult(input, state),
      });
    }
    const sharedWithAlias = this.aliases.find((a) => a.ambiguous_names?.some((n) => normalizeScope(n) === text));
    if (sharedWithAlias) {
      const aliasText = normalizeScope(sharedWithAlias.names[0]);
      interpretations.push({
        option: { label: sharedWithAlias.label, scope: sharedWithAlias.names[0] },
        resolve: () => this.resolveMetroAlias(input, aliasText)!,
      });
    }
    const stateSet = STATE_SETS.find((set) => set.names.some((n) => normalizeScope(n) === text));
    if (stateSet) {
      interpretations.push({
        option: { label: `${stateSet.label} (informal region)`, scope: stateSet.names[0] },
        resolve: () => this.stateSetResult(input, stateSet),
      });
    }
    const division = DIVISIONS.find((d) => [d.name, ...d.aliases].some((n) => normalizeScope(n) === text));
    if (division) {
      interpretations.push({
        option: { label: `${division.name} (Census division)`, scope: division.name },
        resolve: () => this.divisionResult(input, division),
      });
    }
    const region = REGIONS.find((r) => [r.name, ...r.aliases].some((n) => normalizeScope(n) === text));
    if (region) {
      interpretations.push({
        option: { label: `${region.name} (Census region)`, scope: `${region.name} region` },
        resolve: () => this.regionResult(input, region),
      });
    }
    for (const place of this.distinctPlaces(text, state?.code)) {
      interpretations.push({
        option: { label: `${placeLabel(place)} (city)`, scope: `near ${placeLabel(place)}` },
        resolve: () => this.placeResult(input, place),
      });
    }

    if (interpretations.length === 0) return null;
    if (interpretations.length === 1) return interpretations[0].resolve();
    return this.ambiguous(
      input,
      `'${input}' could mean more than one thing.`,
      interpretations.map((i) => i.option),
    );
  }

  /**
   * Places named `text` that compete with a same-named state. A city inside that state is just
   * the state ("New York"), and a small city elsewhere ("Wyoming", MI) is not what someone
   * typing a state name means; only a large one ("Washington", DC) makes the name ambiguous.
   */
  private distinctPlaces(text: string, stateCode: string | undefined): Place[] {
    const places = findPlaces(text, this.placeIndex);
    if (!stateCode) return places;
    return places.filter(
      (p) =>
        !(p.state === stateCode && normalizeScope(p.name) === text) &&
        (p.population ?? Infinity) >= STATE_NAME_CITY_MIN_POPULATION,
    );
  }

  private findState(text: string): StateRow | undefined {
    const byCode = text.length === 2 ? STATE_BY_CODE.get(text.toUpperCase()) : undefined;
    return byCode ?? STATES.find((s) => normalizeScope(s.name) === text);
  }

  private stateResult(input: string, state: StateRow): ScopeResolution<T> {
    const notes = state.division ? [] : [`${state.name} is a U.S. territory; the Census Bureau assigns it no region or division.`];
    return matchedResult(input, "state", state.name, this.airports.filter((a) => a.state === state.code), notes);
  }

  /**
   * An informal region: the airports in an explicit list of states. The definition is part of the
   * result (notes and caption detail) so nothing is silently picked; a contested name says so.
   */
  private stateSetResult(input: string, set: StateSetAlias): ScopeResolution<T> {
    const wanted = new Set(set.states);
    const airports = this.airports.filter((a) => wanted.has(a.state));
    const notes = [set.note];
    if (set.contested) notes.push(`'${set.label}' has no official boundary and definitions vary; the states listed above were used.`);
    const present = new Set(airports.map((a) => a.state));
    const missing = set.states.filter((code) => !present.has(code));
    if (missing.length > 0) notes.push(`No airports in the dataset for: ${missing.join(", ")}.`);
    return { ...matchedResult(input, "informal_region", set.label, airports, notes), detail: set.states.join(", ") };
  }

  private divisionResult(input: string, division: Division): ScopeResolution<T> {
    const codes = STATES.filter((s) => s.division === division.id).map((s) => s.code);
    return this.censusResult(input, "census_division", division.name, `Census division: ${codes.join(", ")}.`, codes);
  }

  private regionResult(input: string, region: Region): ScopeResolution<T> {
    const divisionIds = new Set(DIVISIONS.filter((d) => d.region === region.id).map((d) => d.id));
    const codes = STATES.filter((s) => s.division && divisionIds.has(s.division)).map((s) => s.code);
    const names = DIVISIONS.filter((d) => d.region === region.id).map((d) => d.name);
    return this.censusResult(input, "census_region", region.name, `Census region (${names.join(" + ")}).`, codes);
  }

  private censusResult(
    input: string,
    resolvedAs: ResolvedAs,
    label: string,
    definition: string,
    stateCodes: string[],
  ): ScopeResolution<T> {
    const wanted = new Set(stateCodes);
    const airports = this.airports.filter((a) => wanted.has(a.state));
    const present = new Set(airports.map((a) => a.state));
    const notes = [`${definition} Source: U.S. Census Bureau.`];
    const missing = stateCodes.filter((code) => !present.has(code));
    if (missing.length > 0) notes.push(`No airports in the dataset for: ${missing.join(", ")}.`);
    return matchedResult(input, resolvedAs, label, airports, notes);
  }

  private placeResult(input: string, place: Place): ScopeResolution<T> {
    return this.radiusResult(
      input,
      `${DEFAULT_RADIUS_MILES} mi around ${placeLabel(place)}`,
      place,
      DEFAULT_RADIUS_MILES,
      false,
      [`Read as a place name: the default ${DEFAULT_RADIUS_MILES}-mile radius was used. Say 'within N miles of ...' to change it.`],
    );
  }

  private radiusResult(
    input: string,
    label: string,
    center: { lat: number; lon: number },
    radiusMiles: number,
    explicitRadius: boolean,
    notes: string[],
  ): ScopeResolution<T> {
    const airports = this.withinRadius(center, radiusMiles);
    const allNotes = [
      ...notes,
      "Distance is great-circle from the center to each airport's coordinates.",
    ];
    if (!explicitRadius && notes.length === 0) {
      allNotes.push(`Default radius of ${DEFAULT_RADIUS_MILES} miles.`);
    }
    if (airports.length === 0) {
      const nearest = this.nearest(center);
      if (nearest) {
        allNotes.push(`Nearest covered airport: ${nearest.airport.iata} (${nearest.airport.city}), ${roundMiles(nearest.miles)} mi away.`);
      }
    }
    return matchedResult(input, "radius", label, airports, allNotes);
  }

  private withinRadius(center: { lat: number; lon: number }, radiusMiles: number): T[] {
    return this.airports.filter((a) => haversineMiles(center.lat, center.lon, a.lat, a.lon) <= radiusMiles);
  }

  private nearest(center: { lat: number; lon: number }): { airport: T; miles: number } | null {
    let best: { airport: T; miles: number } | null = null;
    for (const airport of this.airports) {
      const miles = haversineMiles(center.lat, center.lon, airport.lat, airport.lon);
      if (!best || miles < best.miles) best = { airport, miles };
    }
    return best;
  }

  private ambiguous(input: string, message: string, options: ScopeOption[]): ScopeResolution<T> {
    return {
      status: "ambiguous",
      input,
      resolvedAs: null,
      label: input,
      airports: [],
      notes: [`${message} Ask which was meant, or pass one of the option scopes.`],
      options,
    };
  }

  private unknown(input: string, text: string, extraNotes: string[] = []): ScopeResolution<T> {
    const notes = [...extraNotes];
    if (/^[a-z]{3}$/.test(text)) notes.push(`'${input}' is not an airport code in this dataset.`);
    return {
      status: "unknown",
      input,
      resolvedAs: null,
      label: input,
      airports: [],
      notes,
      suggestions: this.suggest(text),
    };
  }

  /** Closest supported scope spellings: substring hits first, then small edit distance. */
  private suggest(text: string): string[] {
    const vocabulary: Array<{ key: string; display: string }> = [];
    for (const state of STATES) vocabulary.push({ key: normalizeScope(state.name), display: state.name });
    for (const d of DIVISIONS) vocabulary.push({ key: normalizeScope(d.name), display: d.name });
    for (const r of REGIONS) vocabulary.push({ key: normalizeScope(r.name), display: r.name });
    for (const set of STATE_SETS) vocabulary.push({ key: normalizeScope(set.names[0]), display: set.label });
    for (const alias of this.aliases) {
      for (const name of alias.names) vocabulary.push({ key: normalizeScope(name), display: alias.names[0] });
    }
    for (const [key, places] of this.placeIndex) {
      for (const place of places) vocabulary.push({ key, display: `near ${placeLabel(place)}` });
    }
    for (const airport of this.airports) vocabulary.push({ key: airport.iata.toLowerCase(), display: airport.iata });

    // Words in common ("pacific shore" -> Pacific, Pacific Northwest), checked before spelling distance.
    const stem = (word: string): string => word.replace(/(?:al|s)$/, "");
    const words = text.split(" ").filter((w) => w.length >= 4 && !STOP_WORDS.has(w)).map(stem);
    const byWords = vocabulary
      .filter((entry) => !entry.display.startsWith("near ") && !/^[A-Z]{3}$/.test(entry.display))
      .map((entry) => {
        const entryWords = entry.key.split(" ").map(stem);
        const shared = words.filter((w) => entryWords.includes(w)).length;
        return { display: entry.display, shared, ratio: shared / entryWords.length };
      })
      .filter((entry) => entry.shared > 0 && entry.display.length > 3)
      .sort((a, b) => b.shared - a.shared || b.ratio - a.ratio || a.display.localeCompare(b.display))
      .map((entry) => entry.display);

    const threshold = Math.max(2, Math.floor(text.length * 0.4));
    const scored = vocabulary
      .map((entry) => {
        const related = text.length >= 3 && (entry.key.includes(text) || text.includes(entry.key));
        return { display: entry.display, distance: related ? 1 : editDistance(text, entry.key) };
      })
      .filter((entry) => entry.distance <= threshold)
      .sort((a, b) => a.distance - b.distance || a.display.localeCompare(b.display));
    return [...new Set([...byWords, ...scored.map((entry) => entry.display)])].slice(0, 4);
  }
}

/**
 * Resolve scope text against `airports`. Deterministic order:
 * all, airport code, named metro alias, metro field, "near/within N miles of",
 * then a bare name: state, Census division, Census region, or place. A bare name that
 * fits more than one of those (e.g. "Portland", "Washington") is returned as
 * "ambiguous" with the options; an unrecognized one as "unknown" with suggestions.
 */
export function resolveScope<T extends GeoAirport>(
  scope: string | null | undefined,
  airports: T[],
  options: GeographyOptions = {},
): ScopeResolution<T> {
  return new ScopeResolver(airports, options).resolve(scope);
}

/**
 * A reusable resolver over a fixed airport list, so the place index (thousands of gazetteer
 * rows) is built once rather than on every call. Same behaviour as resolveScope.
 */
export function createScopeResolver<T extends GeoAirport>(
  airports: T[],
  options: GeographyOptions = {},
): (scope: string | null | undefined) => ScopeResolution<T> {
  const resolver = new ScopeResolver(airports, options);
  return (scope) => resolver.resolve(scope);
}

// --------------------------------------------------------------------------- //
// Coverage (what the dataset can answer about)
// --------------------------------------------------------------------------- //

export interface Coverage {
  airport_count: number;
  states: string[];
  census_divisions: string[];
  metro_aliases: string[];
  /** Informal regions (West Coast, ...), each with a stated state list. */
  informal_regions: string[];
  supported_scopes: string[];
}

/** Honest summary of what a dataset covers, for "no match" answers and the model. */
export function describeCoverage(airports: GeoAirport[], options: GeographyOptions = {}): Coverage {
  const states = [...new Set(airports.map((a) => a.state))].sort();
  const divisionIds = new Set(states.map((code) => STATE_BY_CODE.get(code)?.division).filter(Boolean));
  return {
    airport_count: airports.length,
    states,
    census_divisions: DIVISIONS.filter((d) => divisionIds.has(d.id)).map((d) => d.name),
    metro_aliases: [...(options.metroAliases ?? []), ...BUNDLED_ALIASES].map((alias) => alias.names[0]),
    informal_regions: STATE_SETS.map((set) => set.label),
    supported_scopes: SUPPORTED_SCOPE_KINDS,
  };
}

/** Census division of a state code, e.g. for diagnostics and tests. */
export function censusDivisionOf(stateCode: string): string | null {
  const division = STATE_BY_CODE.get(stateCode.toUpperCase())?.division;
  return division ? (DIVISION_BY_ID.get(division)?.name ?? null) : null;
}
