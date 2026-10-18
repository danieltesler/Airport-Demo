/**
 * A spoken line should say "Los Angeles", not "L-A-X's". Airport codes in the model's voice line are
 * replaced by the airport's city, unless two codes in the line share a city (then the codes stay so the
 * listener can tell them apart). "Los Angeles (LAX)" simply loses the parenthesis.
 */

import * as data from "./data";

export function speakableAirportNames(spoken: string): string {
  const codes = [...new Set(spoken.match(/\b[A-Z]{3}\b/g) ?? [])].filter((code) => data.getAirport(code));
  const cityOf = (code: string): string => data.getAirport(code)!.city.split(/[-/,]/)[0].trim();
  const cities = codes.map(cityOf);
  let out = spoken;
  for (const code of codes) {
    const city = cityOf(code);
    if (cities.filter((c) => c === city).length > 1) continue; // two airports of one city: keep the codes
    out = out.replace(new RegExp(`\\s*\\(${code}\\)`, "g"), "");
    out = out.replace(new RegExp(`\\b${code}\\b`, "g"), city);
  }
  return out.replace(/\s{2,}/g, " ").trim();
}
