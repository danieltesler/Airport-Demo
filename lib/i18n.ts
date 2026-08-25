/**
 * The code-owned text: assumptions, uncertainty caveats, and panel labels. These
 * come from the code (not the LLM) so they stay consistent and trustworthy. The app
 * is English-only.
 */

export const ASSUMPTIONS = {
  congestion: [
    "Congestion is proxied by operational strain: departure delays, the share of " +
      "flights delayed >15 min, cancellations, and seat load factor.",
    "Metrics are compared as rates (per-flight / per-seat), not totals, so large " +
      "hubs and small airports are judged on the same footing.",
  ],
  unmet: [
    "'Unmet demand' has no direct public measurement (bookings that never happened " +
      "aren't observable in free data). We estimate it as a composite lower-bound proxy.",
    "Load factor is the primary signal: sustained high seat utilization implies " +
      "demand that current supply cannot absorb.",
    "Growth measured against roughly fixed runway capacity indicates a widening gap.",
  ],
  expansion: [
    "Investment thesis: terminal expansion is most profitable where strong, growing " +
      "demand meets a capacity-constrained airport — so renovation unlocks revenue " +
      "rather than adding idle space.",
    "Score blends demand growth, current congestion, seat load pressure, and passenger " +
      "volume; weights are documented and adjustable.",
    "Airport scope is limited to the bundled dataset (major + selected mid-size U.S. airports).",
  ],
};

export const UNCERTAINTY = {
  congestion:
    "Delay data reflects annual averages; short-term peaks (holidays, weather events) " +
    "are smoothed out. Delays also mix weather with true capacity saturation.",
  unmet:
    "This is a lower-bound proxy. True unmet demand (searches that didn't convert, " +
    "fares that priced people out) requires proprietary GDS/OAG data not available for free.",
  expansion:
    "Score reflects demand-side opportunity only. It does not model construction cost, " +
    "land/gate availability, or local regulatory limits (e.g. noise curfews), which a " +
    "full investment case would weigh.",
};

/** Dataset-scope assumption (dynamic airport count). */
export function scopeAssumption(count: number): string {
  return `Dataset scope is limited to ${count} U.S. airports.`;
}

/** Haul-mix assumptions (dynamic distance thresholds). */
export function haulAssumptions(t: { short_max: number; long_min: number }): string[] {
  return [
    `Haul class is by great-circle route distance from T-100 segment data: short ` +
      `<${t.short_max} mi, medium ${t.short_max}-${t.long_min} mi, long >${t.long_min} mi.`,
    "Percentages are shares of departures performed, not passengers or seats.",
  ];
}

/** Assumptions and caveat for the live flights tool. */
export function liveFlightsAssumptions(): string[] {
  return [
    "Live positions come from a community ADS-B feed (adsb.lol), for aircraft within " +
      "about 30 nautical miles of the airport at the moment you asked.",
    "Coverage depends on nearby receivers, so the count is a lower bound on real " +
      "traffic; aircraft on the ground are counted separately.",
  ];
}

export const LIVE_FLIGHTS_UNCERTAINTY =
  "This is a real-time snapshot, not a schedule — the numbers change minute to " +
  "minute, and low-altitude or non-ADS-B aircraft may be missed.";

/** UI labels for the assumptions & uncertainty panel. */
export const PANEL_LABELS = {
  title: "Assumptions & uncertainty",
  assumptions: "Assumptions",
  uncertainty: "Uncertainty",
  dataVintage: "Data vintage",
  tools: "Tools",
};
