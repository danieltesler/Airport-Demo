/**
 * Shared scope handling for tools that take place words: resolve them to airports with the
 * deterministic resolver, prefer the user's own words over the model's rewrite, and turn a
 * failed resolution into an error result that states the facts instead of an empty table.
 */

import * as data from "./data";
import type { Airport } from "./data";
import { ASK_FOR_LOCATION_NOTE } from "./geography";
import type { ScopeResolution } from "./geography";
import type { ToolOutput } from "./tools";

/** Error result for an airport code that is not in the dataset. */
export function unknownAirport(iata: string): ToolOutput {
  return { result: { error: `'${iata}' is not in the dataset.`, known_airports: data.knownIatas() } };
}

/**
 * Tool error for a scope that did not resolve to airports. Never an empty table and
 * never a guess: it says why, offers options or suggestions, and states what the
 * dataset covers so the model can only relay facts it was given.
 */
export function scopeProblem(resolution: ScopeResolution<Airport>): ToolOutput {
  const messages: Record<string, string> = {
    ambiguous: `Scope '${resolution.input}' is ambiguous. Ask the user which one they mean, or call again with one option's scope.`,
    empty: `Scope '${resolution.input}' was understood as ${resolution.label}, but no airports in the dataset fall in it.`,
    unknown: `I don't have '${resolution.input}' as a ready-made area.`,
  };
  const suggestions = resolution.suggestions ?? [];
  const asChoice = (items: string[]): string => (items.length > 1 ? `${items.slice(0, -1).join(", ")} or ${items.at(-1)}` : items[0]);
  const aroundTheUser = resolution.notes.includes(ASK_FOR_LOCATION_NOTE);
  const unknownReply = aroundTheUser
    ? "I don't know where you are. Tell me a city, state or airport and I'll look at the airports around it."
    : suggestions.length > 0
      ? `I don't have '${resolution.input}' as a ready-made area. Did you mean ${asChoice(suggestions)}?`
      : `I don't have '${resolution.input}' as a ready-made area. I can use a U.S. state, a region such as the Northeast or the West Coast, a metro like the Bay Area, or 'near <city>'.`;
  return {
    result: {
      error: messages[resolution.status] ?? `Scope '${resolution.input}' could not be resolved.`,
      status: resolution.status,
      ...(resolution.status === "unknown"
        ? {
            suggested_reply: unknownReply,
            reply_instruction:
              "Say this plainly in your own words, offering only the suggestions given. Do not use the words 'scope' or 'recognized'.",
          }
        : {}),
      options: resolution.options,
      suggestions: resolution.suggestions,
      notes: resolution.notes,
      coverage: data.datasetCoverage(),
    },
  };
}

/**
 * Resolve the scope for a tool call. The user's own words (`userWords`) win over the
 * model's `scope` string, because models tend to translate or narrow a place
 * ("northeast" -> "new england"). When the two disagree the difference is recorded as
 * a note so the reply and caption never claim more or less than what was resolved.
 */
/** Longest place text the resolver reads. Real places are far shorter; the cap keeps a huge input from costing CPU. */
export const MAX_PLACE_CHARS = 200;

export const capPlaceText = (text: string | undefined): string | undefined => text?.slice(0, MAX_PLACE_CHARS);

export function resolveToolScope(rawScope: string | undefined, rawUserWords?: string): ScopeResolution<Airport> {
  const scope = capPlaceText(rawScope);
  const userWords = capPlaceText(rawUserWords);
  const words = (userWords ?? "").trim();
  // With no scope passed, unrecognized words must stay unrecognized instead of silently meaning "all".
  const passed = data.resolveAirportScope(scope?.trim() ? scope : words || scope);
  if (!words) return passed;

  const fromWords = data.resolveAirportScope(words);
  if (fromWords.status === "unknown") return passed;

  const sameAirports = (a: Airport[], b: Airport[]): boolean =>
    a.length === b.length && a.every((x) => b.some((y) => y.iata === x.iata));
  const agrees = passed.status === "matched" && sameAirports(passed.airports, fromWords.airports);
  if (agrees) return fromWords;

  // A point-like scope the model settled on (an airport, or "near Springfield, IL" picked from an
  // ambiguity option) that lies inside the user's wider words ("Illinois") is the narrower, more
  // specific reading: keep it instead of widening the answer to the whole state.
  const pointLike = passed.resolvedAs === "radius" || passed.resolvedAs === "airport";
  const matchedInside =
    passed.status === "matched" &&
    pointLike &&
    passed.airports.length > 0 &&
    passed.airports.length < fromWords.airports.length &&
    passed.airports.every((x) => fromWords.airports.some((y) => y.iata === x.iata));
  // A place inside the user's state with no covered airport nearby ("50 mi around Springfield, IL")
  // is "empty": say so (with the nearest covered airport) rather than answering for the whole state.
  const stateOfPlace = passed.label.match(/, ([A-Z]{2})$/)?.[1];
  const emptyInside =
    passed.status === "empty" &&
    passed.resolvedAs === "radius" &&
    stateOfPlace !== undefined &&
    fromWords.airports.some((y) => y.state === stateOfPlace);
  const insideUsersArea = matchedInside || emptyInside;
  if (insideUsersArea) {
    return {
      ...passed,
      notes: [
        ...passed.notes,
        `The passed scope '${scope!.trim()}' lies inside the user's words '${words}', so the narrower scope was kept. ` +
          `Describe the area as ${passed.label}.`,
      ],
    };
  }

  const asked = scope?.trim() ? `'${scope.trim()}'` : "no scope";
  return {
    ...fromWords,
    notes: [
      ...fromWords.notes,
      `The scope was resolved from the user's words '${words}', not from the passed scope ${asked}. ` +
        `Describe the area as ${fromWords.label}; do not describe it as ${asked}.`,
    ],
  };
}

export const SCOPE_DESCRIPTION =
  "Area, as the user's own place words, passed through VERBATIM. Never translate, narrow, " +
  "broaden or substitute them (e.g. 'northeast' stays 'northeast', not 'new england'; a " +
  "city stays the city). Code resolves them: 'all'; a U.S. state (name or postal code); a " +
  "Census division or region; an informal region such as the West Coast or Gulf Coast; a named metro; an airport code; 'near <city or airport code>'; " +
  "'within N miles of <city or airport code>'. If the tool reports the scope as ambiguous, " +
  "unknown or empty, relay its options, suggestions and coverage to the user.";

export const USER_WORDS_DESCRIPTION =
  "The place words copied exactly from the user's latest message (just the place, e.g. " +
  "'Northeast US including New York and New Jersey'). Code resolves these and prefers them " +
  "over 'scope', so always fill this in when the user named a place.";
