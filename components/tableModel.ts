/**
 * Pure helpers that decide how a structured table is aligned, formatted and charted.
 * They read the payload's own shape (header names and cell types), never the tool that
 * produced it, so any new table kind renders sensibly without a component change.
 */

import type { StructuredResult } from "@/lib/types";

/** Defensive: a producer may send null/undefined for a suppressed value. */
export type RawCell = StructuredResult["rows"][number][number] | null | undefined;

export type ColumnKind = "number" | "percent" | "text";

export const INSUFFICIENT_DATA_TEXT = "insufficient data";
const NOT_AVAILABLE_TEXT = "n/a";

const PERCENT_PATTERN = /^[-+]?\d+(\.\d+)?%$/;
const DELTA_HEADER_PATTERN = /(change|delta|yoy)/i;
const SCORE_HEADER_PATTERN = /score$/i;
/** Placeholder strings that mean "no value"; they must not decide a column's kind. */
const MISSING_TEXT = new Set([INSUFFICIENT_DATA_TEXT, NOT_AVAILABLE_TEXT, "—", "-", ""]);

/** Words that stand in for a number in a numeric column (a route that is new or ended, no data). */
const NUMERIC_PLACEHOLDERS = new Set([...MISSING_TEXT, "new", "ended"]);

const isNumericPlaceholder = (cell: RawCell): boolean =>
  typeof cell === "string" && NUMERIC_PLACEHOLDERS.has(cell.trim().toLowerCase());

export function isMissing(cell: RawCell): boolean {
  if (cell === null || cell === undefined) return true;
  if (typeof cell === "number") return !Number.isFinite(cell);
  return MISSING_TEXT.has(cell.trim().toLowerCase());
}

/** Column kind from its real cells: numeric and percent columns align right, text left. */
export function columnKind(rows: RawCell[][], index: number): ColumnKind {
  const present = rows.map((row) => row[index]).filter((cell) => !isMissing(cell) && !isNumericPlaceholder(cell));
  if (present.length === 0) return "text";
  if (present.every((cell) => typeof cell === "number")) return "number";
  if (present.every((cell) => typeof cell === "string" && PERCENT_PATTERN.test(cell.trim()))) return "percent";
  return "text";
}

/**
 * Kinds for every column. The declared score column is always numeric, even when all its
 * cells are placeholders, so it stays aligned with its numeric neighbours.
 */
export function columnKinds(columns: string[], rows: RawCell[][]): ColumnKind[] {
  const scoreIndex = scoreColumnIndex(columns);
  return columns.map((_, i) => (i === scoreIndex ? "number" : columnKind(rows, i)));
}

/** Index of the column the payload declares as its score ("... score"), or -1. */
export function scoreColumnIndex(columns: string[]): number {
  return columns.findIndex((column) => SCORE_HEADER_PATTERN.test(column.trim()));
}

/** Text to show for a cell. A missing score reads "insufficient data"; other gaps read "n/a". */
export function displayCell(cell: RawCell, column: string, isScoreColumn: boolean): string {
  if (cell === null || cell === undefined || (typeof cell === "number" && !Number.isFinite(cell))) {
    return isScoreColumn ? INSUFFICIENT_DATA_TEXT : NOT_AVAILABLE_TEXT;
  }
  if (typeof cell === "string") return cell;
  const text = Number.isInteger(cell)
    ? cell.toLocaleString("en-US")
    : cell.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return DELTA_HEADER_PATTERN.test(column) && cell > 0 ? `+${text}` : text;
}

export interface ChartBar {
  label: string;
  display: string;
  widthPct: number;
}

export interface ChartModel {
  measureLabel: string;
  ariaLabel: string;
  bars: ChartBar[];
  /** Rows left out because they have no numeric score (insufficient data). */
  skippedLabels: string[];
}

/** First text column is the row label; falls back to column 0. */
export function labelColumnIndex(rows: RawCell[][], columns: string[]): number {
  const index = columnKinds(columns, rows).findIndex((kind) => kind === "text");
  return index === -1 ? 0 : index;
}

const labelOf = (row: RawCell[], index: number): string => String(row[index] ?? "");

const isNumericScore = (cell: RawCell): cell is number => typeof cell === "number" && Number.isFinite(cell);

/**
 * A chart is drawn only for score-like tables: the payload must declare a "... score"
 * column with at least one numeric value. Rows without a numeric score are skipped and
 * reported, never drawn as empty or zero-width bars.
 */
export function buildChart(data: StructuredResult): ChartModel | null {
  const { kind, columns, rows } = data;
  if (kind === "metric" || rows.length === 0) return null;

  const measure = scoreColumnIndex(columns);
  if (measure === -1) return null;

  const labelIndex = labelColumnIndex(rows, columns);
  if (labelIndex === measure) return null;

  const scored = rows.filter((row) => isNumericScore(row[measure]));
  const skippedLabels = rows.filter((row) => !isNumericScore(row[measure])).map((row) => labelOf(row, labelIndex));
  const maxValue = Math.max(...scored.map((row) => row[measure] as number), 0);
  if (scored.length === 0 || maxValue <= 0) return null;

  return {
    measureLabel: columns[measure],
    ariaLabel: `${columns[measure]} by ${columns[labelIndex]}`,
    bars: scored.map((row) => ({
      label: labelOf(row, labelIndex),
      display: displayCell(row[measure], columns[measure], true),
      widthPct: Math.max(((row[measure] as number) / maxValue) * 100, 1),
    })),
    skippedLabels,
  };
}

/** Labels of rows whose score is missing, so the explain panel can say who was not scored. */
export function unscoredLabels(data: StructuredResult): string[] {
  const measure = scoreColumnIndex(data.columns);
  if (measure === -1) return [];
  const labelIndex = labelColumnIndex(data.rows, data.columns);
  return data.rows.filter((row) => isMissing(row[measure])).map((row) => labelOf(row, labelIndex));
}

const KEY_MEASURE_HEADER = /(%|share|change|yoy)/i;

/**
 * Column display order. Wide metric tables (carrier share, capacity trend) put the label
 * first and the key measures (percent, share, change) next, so they stay visible on a
 * narrow screen; ranking, comparison and breakdown tables keep the payload's order.
 */
export function displayOrder(data: StructuredResult): number[] {
  const { kind, columns, rows } = data;
  const identity = columns.map((_, i) => i);
  if (kind !== "metric" || columns.length <= 2) return identity;

  const kinds = columnKinds(columns, rows);
  const label = labelColumnIndex(rows, columns);
  const isKeyMeasure = (i: number) => i !== label && (kinds[i] === "percent" || KEY_MEASURE_HEADER.test(columns[i]));
  return [label, ...identity.filter(isKeyMeasure), ...identity.filter((i) => i !== label && !isKeyMeasure(i))];
}
