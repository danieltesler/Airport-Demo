/**
 * Builds the "How was this scored?" payload from the real scorer outputs and the
 * exported weights in scoring.ts. Nothing here recomputes a score: points are just
 * weight x component, which is exactly what the scorers sum. Points are rounded together
 * (largest remainder) so each row's parts add up exactly to its displayed score. Airports whose score is
 * "insufficient data" have no components and are left out of the breakdown.
 */

import type { Airport } from "./data";
import { METRIC_SCORERS, METRIC_WEIGHTS, isScored, type MetricKey } from "./scoring";
import { COMPONENT_LABELS, METRIC_LABELS } from "./i18n";
import { largestRemainder, roundTo } from "./rounding";
import type { ScoreExplanation } from "./types";


export function explainScores(
  airports: Airport[],
  metric: MetricKey,
  labelOf: (a: Airport) => string,
): ScoreExplanation {
  const weights = METRIC_WEIGHTS[metric];
  const scorer = METRIC_SCORERS[metric];

  const rows = airports.flatMap((a) => {
    const result = scorer(a);
    if (!isScored(result)) return [];
    const entries = Object.entries(weights);
    const score = roundTo(result.score, 1);
    // The parts add up to the score exactly as shown: round them together, not one by one.
    const points = largestRemainder(
      entries.map(([key, weight]) => 100 * weight * result.components[key]),
      score,
      1,
    );
    return [
      {
        airport: labelOf(a),
        score,
        parts: entries.map(([key], i) => ({ value: roundTo(result.components[key], 3), points: points[i] })),
      },
    ];
  });

  return {
    metricLabel: METRIC_LABELS[metric],
    components: Object.entries(weights).map(([key, weight]) => ({
      label: COMPONENT_LABELS[key] ?? key,
      weight,
    })),
    rows,
  };
}
