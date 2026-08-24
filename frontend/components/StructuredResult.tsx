import type { Cell, StructuredResult as StructuredData } from "@/lib/types";
import styles from "./StructuredResult.module.css";

interface StructuredResultProps {
  data: StructuredData;
}

/**
 * Renders the agent's structured payload as a tidy table, plus a pure-CSS
 * horizontal bar chart for kinds that compare a single measure across rows
 * (ranking / comparison / breakdown). `metric` shows just the table.
 */
export function StructuredResult({ data }: StructuredResultProps) {
  const { kind, columns, rows } = data;
  const chart = buildChart(data);

  return (
    <section className={styles.wrap} aria-label={`${kind} result`}>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((col, i) => (
                <th key={i} className={i === 0 ? styles.thLabel : styles.thNum}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} className={c === 0 ? styles.tdLabel : styles.tdNum}>
                    {formatCell(cell)}
                  </td>
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
                <div
                  className={styles.barFill}
                  style={{ width: `${bar.widthPct}%` }}
                />
              </div>
              <span className={styles.barValue}>{bar.display}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface ChartBar {
  label: string;
  display: string;
  widthPct: number;
}

interface ChartModel {
  measureLabel: string;
  ariaLabel: string;
  bars: ChartBar[];
}

/**
 * Build a bar chart when the data has a label column and at least one numeric
 * column. We chart the first numeric column (the primary measure). Returns null
 * when a chart wouldn't be meaningful (e.g. no numeric column, or a single
 * scalar `metric`).
 */
function buildChart(data: StructuredData): ChartModel | null {
  const { kind, columns, rows } = data;
  if (kind === "metric") return null;
  if (rows.length === 0 || columns.length < 2) return null;

  const measureIndex = columns.findIndex(
    (_, i) => i > 0 && rows.every((row) => typeof row[i] === "number")
  );
  if (measureIndex === -1) return null;

  const values = rows.map((row) => Number(row[measureIndex]));
  const maxValue = Math.max(...values, 0);
  if (maxValue <= 0) return null;

  const bars: ChartBar[] = rows.map((row, i) => ({
    label: String(row[0]),
    display: formatCell(row[measureIndex]),
    widthPct: Math.max((values[i] / maxValue) * 100, 1),
  }));

  return {
    measureLabel: columns[measureIndex],
    ariaLabel: `${columns[measureIndex]} by ${columns[0]}`,
    bars,
  };
}

/** Format numbers compactly; pass strings through unchanged. */
function formatCell(cell: Cell): string {
  if (typeof cell !== "number") return cell;
  if (Number.isInteger(cell)) return cell.toLocaleString("en-US");
  return cell.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
