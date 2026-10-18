// Pure aggregation of BTS On-Time Performance rows (Reporting Carrier) per origin airport.
import { readZippedCsv } from "./csv-stream.mjs";

// Airports with fewer scheduled departures in the year than this get null metrics.
// 5,000 is about 14 a day: enough that one bad week cannot swing the percentages.
export const MIN_SCHEDULED_DEPARTURES = 5000;

export function createOntimeAccumulator() {
  return { airports: new Map(), rowsRead: 0 };
}

function emptyAirport() {
  return { scheduled: 0, cancelled: 0, measured: 0, delayMinutes: 0, delayed15: 0 };
}

export function addOntimeRow(acc, row) {
  acc.rowsRead++;
  const totals = acc.airports.get(row.Origin) ?? emptyAirport();
  totals.scheduled++;
  if (Number(row.Cancelled) === 1) {
    totals.cancelled++;
  } else if (row.DepDelayMinutes !== "" && row.DepDelayMinutes !== undefined) {
    totals.measured++;
    totals.delayMinutes += Number(row.DepDelayMinutes);
    if (Number(row.DepDel15) === 1) totals.delayed15++;
  }
  acc.airports.set(row.Origin, totals);
}

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

export function finalizeOntimeAirport(totals) {
  const base = { scheduled_departures: totals.scheduled, measured_departures: totals.measured };
  if (totals.scheduled < MIN_SCHEDULED_DEPARTURES || totals.measured === 0) {
    return { ...base, avg_dep_delay_min: null, delayed_share: null, cancel_rate: null };
  }
  return {
    ...base,
    // DepDelayMinutes is floored at 0 (early departures count as 0), the BTS convention.
    avg_dep_delay_min: round(totals.delayMinutes / totals.measured, 2),
    delayed_share: round(totals.delayed15 / totals.measured, 4),
    cancel_rate: round(totals.cancelled / totals.scheduled, 4),
  };
}

export async function aggregateOntimeZips(zipPaths) {
  const acc = createOntimeAccumulator();
  for (const zipPath of zipPaths) {
    const before = acc.rowsRead;
    for await (const row of readZippedCsv(zipPath)) addOntimeRow(acc, row);
    if (acc.rowsRead === before) throw new Error(`no rows read from ${zipPath}`);
  }
  return acc;
}
