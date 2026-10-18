// Chooses which airports the dataset covers and measures how much traffic that covers.

// The 28 airports of the original prototype. They stay covered even when they fall outside the
// top 100 (BTV and MHT do), so earlier answers and tests keep a subject. Pinned here rather than
// read from data/airports.json, which is now this pipeline's own output.
export const GUARANTEED_IATAS = [
  "BOS", "BDL", "PVD", "MHT", "PWM", "BTV", "LAX", "SNA", "ANC", "SFO", "JFK", "LGA", "EWR", "ATL",
  "ORD", "DFW", "DEN", "SEA", "LAS", "MCO", "MIA", "PHX", "CLT", "OAK", "SJC", "SAN", "DCA", "IAD",
];

/**
 * passengersByIata: Map<iata, passengers>. Returns the top `count` airports by passengers,
 * plus every guaranteed airport even if it ranks lower, and the share of national passengers covered.
 */
export function selectCoverage(passengersByIata, guaranteedIatas, count = 100) {
  const ranked = [...passengersByIata.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const selected = new Set(ranked.slice(0, count).map(([iata]) => iata));
  const missingGuaranteed = guaranteedIatas.filter((iata) => !passengersByIata.has(iata));
  if (missingGuaranteed.length > 0) {
    throw new Error(`guaranteed airports missing from the traffic data: ${missingGuaranteed.join(", ")}`);
  }
  for (const iata of guaranteedIatas) selected.add(iata);

  const nationalTotal = ranked.reduce((sum, [, pax]) => sum + pax, 0);
  const coveredTotal = [...selected].reduce((sum, iata) => sum + passengersByIata.get(iata), 0);
  return {
    selected: ranked.map(([iata]) => iata).filter((iata) => selected.has(iata)),
    coveredShare: coveredTotal / nationalTotal,
    nationalTotal,
    coveredTotal,
    airportsInNationalTotal: ranked.length,
  };
}
