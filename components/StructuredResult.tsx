import type { StructuredResult as StructuredData } from "@/lib/types";
import { ScoreBreakdown } from "./ScoreBreakdown";
import {
  buildChart,
  columnKinds,
  displayCell,
  isMissing,
  labelColumnIndex,
  scoreColumnIndex,
  unscoredLabels,
  type ColumnKind,
} from "./tableModel";
import styles from "./StructuredResult.module.css";

interface StructuredResultProps {
  data: StructuredData;
}

/**
 * Renders the agent's structured payload as a tidy table, plus a pure-CSS horizontal
 * bar chart when the table declares a "... score" column. Alignment, formatting and
 * charting are decided from the payload's own columns (see tableModel.ts), so any
 * table kind renders sensibly.
 */
export function StructuredResult({ data }: StructuredResultProps) {
  const { kind, columns, rows, caption, explain } = data;
  const chart = buildChart(data);
  const kinds = columnKinds(columns, rows);
  const scoreIndex = scoreColumnIndex(columns);
  const firstTextIndex = labelColumnIndex(rows, columns);
  const notScored = unscoredLabels(data);

  return (
    <section className={styles.wrap} aria-label={`${kind} result`}>
      <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Table, scrolls sideways">
        <table className={styles.table}>
          {caption && <caption className={styles.caption}>{caption}</caption>}
          <thead>
            <tr>
              {columns.map((col, i) => (
                <th key={i} scope="col" className={kinds[i] === "text" ? styles.thLabel : styles.thNum}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {columns.map((col, c) => (
                  <Cell
                    key={c}
                    text={displayCell(row[c], col, c === scoreIndex)}
                    missing={isMissing(row[c])}
                    kind={kinds[c]}
                    isRowLabel={c === firstTextIndex}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {chart && (
        <div className={styles.chart} role="img" aria-label={chart.ariaLabel}>
          <div className={styles.chartCaption}>{chart.measureLabel}</div>
          {chart.bars.map((bar, i) => (
            <div key={i} className={styles.barRow}>
              <span className={styles.barLabel} title={bar.label}>
                {bar.label}
              </span>
              <div className={styles.barTrack}>
                <div className={styles.barFill} style={{ width: `${bar.widthPct}%` }} />
              </div>
              <span className={styles.barValue}>{bar.display}</span>
            </div>
          ))}
          {chart.skippedLabels.length > 0 && (
            <p className={styles.chartNote}>
              Not charted (insufficient data): {chart.skippedLabels.join(", ")}
            </p>
          )}
        </div>
      )}

      {explain && explain.rows.length > 0 && <ScoreBreakdown explain={explain} notScored={notScored} />}
    </section>
  );
}

interface CellProps {
  text: string;
  missing: boolean;
  kind: ColumnKind;
  isRowLabel: boolean;
}

/** One body cell: numbers right-aligned, text left-aligned and ellipsised with the full text on hover. */
function Cell({ text, missing, kind, isRowLabel }: CellProps) {
  const alignment = kind === "text" ? (isRowLabel ? styles.tdLabel : styles.tdText) : styles.tdNum;
  const className = missing ? `${alignment} ${styles.tdMissing}` : alignment;
  return (
    <td className={className}>
      {kind === "text" ? (
        <span className={styles.truncate} title={text}>
          {text}
        </span>
      ) : (
        text
      )}
    </td>
  );
}
