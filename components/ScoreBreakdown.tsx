import type { ScoreExplanation } from "@/lib/types";
import { PANEL_LABELS } from "@/lib/i18n";
import styles from "./ScoreBreakdown.module.css";

/**
 * Collapsed-by-default "How was this scored?" panel. Rows are components with their
 * weight; each airport column shows the points that component contributed. The points
 * arrive pre-rounded so each column adds up exactly to the score shown. A native <details>
 * keeps it keyboard- and screen-reader-accessible without any state.
 */
interface ScoreBreakdownProps {
  explain: ScoreExplanation;
  /** Airports in the table that have no score; named so a missing column is explained. */
  notScored?: string[];
}

export function ScoreBreakdown({ explain, notScored = [] }: ScoreBreakdownProps) {
  return (
    <details className={styles.details}>
      <summary className={styles.summary}>{PANEL_LABELS.explainSummary}</summary>

      <div className={styles.body}>
        <p className={styles.intro}>
          {explain.metricLabel} score = sum of weight x component (each component is
          normalized to 0-1), scaled to 0-100. Cells show points, with the 0-1 component
          value beneath. Points are rounded so each column adds up exactly to the score.
        </p>

        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Component</th>
                <th scope="col" className={styles.num}>
                  Weight
                </th>
                {explain.rows.map((row) => (
                  <th key={row.airport} scope="col" className={styles.num}>
                    {row.airport.split(" ")[0]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {explain.components.map((component, i) => (
                <tr key={component.label}>
                  <th scope="row">{component.label}</th>
                  <td className={styles.num}>{Math.round(component.weight * 100)}%</td>
                  {explain.rows.map((row) => (
                    <td key={row.airport} className={styles.num}>
                      {row.parts[i].points}
                      <span className={styles.value}>{row.parts[i].value}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Score</th>
                <td className={styles.num}>100%</td>
                {explain.rows.map((row) => (
                  <td key={row.airport} className={styles.num}>
                    {row.score}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>

        {notScored.length > 0 && (
          <p className={styles.note}>Not scored (insufficient data): {notScored.join(", ")}</p>
        )}
      </div>
    </details>
  );
}
