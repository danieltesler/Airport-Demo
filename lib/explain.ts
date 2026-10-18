/**
 * Builds the "How was this scored?" payload from the real scorer outputs and the
 * exported weights in scoring.ts. Nothing here recomputes a score: points are just
 * weight x component, which is exactly what the scorers sum.
 */

import type { Airport } from "./data";
import { METRIC_SCORERS, METRIC_WEIGHTS, loadFactorInfluence, type MetricKey } from "./scoring";
import { COMPONENT_LABELS, METRIC_LABELS, loadFactorDoubleCountNote } from "./i18n";
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

  const rows = airports.map((a) => {
    const result = scorer(a);
    return {
      airport: labelOf(a),
      score: round1(result.score),
      parts: Object.entries(weights).map(([key, weight]) => ({
        value: round3(result.components[key]),
        points: round1(100 * weight * result.components[key]),
      })),
    };
  });

  const influence = loadFactorInfluence(metric);
  const notes =
    influence.viaCongestion > 0
      ? [loadFactorDoubleCountNote(influence.direct, influence.viaCongestion)]
      : [];

  return {
    metricLabel: METRIC_LABELS[metric],
    components: Object.entries(weights).map(([key, weight]) => ({
      label: COMPONENT_LABELS[key] ?? key,
      weight,
    })),
    rows,
    notes,
  };
}
