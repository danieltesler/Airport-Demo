/**
 * Builds the "How was this scored?" payload from the real scorer outputs and the
 * exported weights in scoring.ts. Nothing here recomputes a score: points are just
 * weight x component, which is exactly what the scorers sum. Airports whose score is
 * "insufficient data" have no components and are left out of the breakdown.
 */

import type { Airport } from "./data";
import { METRIC_SCORERS, METRIC_WEIGHTS, isScored, type MetricKey } from "./scoring";
import { COMPONENT_LABELS, METRIC_LABELS } from "./i18n";
import type { ScoreExplanation } from "./types";

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

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
    return [
      {
        airport: labelOf(a),
        score: round1(result.score),
        parts: Object.entries(weights).map(([key, weight]) => ({
          value: round3(result.components[key]),
          points: round1(100 * weight * result.components[key]),
        })),
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
