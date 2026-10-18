/**
 * Carrier names for the BTS carrier codes used in the route data.
 *
 * The route table carries only BTS UNIQUE_CARRIER codes. data/carriers.json maps the codes
 * that matter (99% of 2025 seats) to names, taken from the BTS carrier lookup table, and its
 * meta block states the source. A code that is not in the table is shown as the raw code:
 * a name is never guessed.
 */

import table from "@/data/carriers.json";

interface CarrierRecord {
  name: string;
  bts_description: string;
  operating_carrier?: boolean;
}

const CARRIERS = table.carriers as Record<string, CarrierRecord>;

export interface CarrierInfo {
  code: string;
  /** Display name from the BTS lookup; null when the code is not in the table. */
  name: string | null;
  /** A regional airline that flies under another airline's brand, so the ticket may show a different name. */
  operatingCarrier: boolean;
  /** Text for tables and replies, e.g. "Southwest Airlines (WN)" or the raw code when unknown. */
  label: string;
}

export function describeCarrier(code: string): CarrierInfo {
  const record = CARRIERS[code];
  if (!record) return { code, name: null, operatingCarrier: false, label: code };
  const operatingCarrier = record.operating_carrier === true;
  const label = operatingCarrier ? `${record.name} (${code}, operating carrier)` : `${record.name} (${code})`;
  return { code, name: record.name, operatingCarrier, label };
}

/** Where the names come from, for provenance text and tests. */
export function carrierTableSource(): { source: string; url: string; retrieved: string; codes: number } {
  const { source, url, retrieved } = table.meta;
  return { source, url, retrieved, codes: Object.keys(CARRIERS).length };
}
