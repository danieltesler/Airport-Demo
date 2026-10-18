/**
 * Shared scope handling for tools that take place words: resolve them to airports with the
 * deterministic resolver, prefer the user's own words over the model's rewrite, and turn a
 * failed resolution into an error result that states the facts instead of an empty table.
 */

import * as data from "./data";
import type { Airport } from "./data";
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
    unknown: `Scope '${resolution.input}' was not recognized.`,
  };
  return {
    result: {
      error: messages[resolution.status] ?? `Scope '${resolution.input}' could not be resolved.`,
      status: resolution.status,
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
export function resolveToolScope(scope: string | undefined, userWords?: string): ScopeResolution<Airport> {
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
  "Census division or region; a named metro; an airport code; 'near <city or airport code>'; " +
  "'within N miles of <city or airport code>'. If the tool reports the scope as ambiguous, " +
  "unknown or empty, relay its options, suggestions and coverage to the user.";

export const USER_WORDS_DESCRIPTION =
  "The place words copied exactly from the user's latest message (just the place, e.g. " +
  "'Northeast US including New York and New Jersey'). Code resolves these and prefers them " +
  "over 'scope', so always fill this in when the user named a place.";
