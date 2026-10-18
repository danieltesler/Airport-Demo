// Downloads the BTS T-100 Segment (All Carriers, table FMG) for one calendar year.
//
// The BTS download page is an ASP.NET WebForms page: GET it for the hidden state
// fields, then POST the same form with the columns we want ticked. The response
// is a zip. If BTS changes the form this fails loudly and the manual path in
// docs/ingest-manual-t100.txt (drop file into data/.cache/manual/) still works.
import { mkdir, writeFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CACHE_DIR, USER_AGENT, sha256OfFile, fail } from "./common.mjs";

const FORM_URL =
  "https://www.transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FMG&QO_fu146_anzr=Nv4%20Pn44vr45";

export const T100_COLUMNS = [
  "DEPARTURES_SCHEDULED", "DEPARTURES_PERFORMED", "SEATS", "PASSENGERS", "FREIGHT", "MAIL",
  "DISTANCE", "UNIQUE_CARRIER", "ORIGIN", "ORIGIN_CITY_MARKET_ID", "ORIGIN_CITY_NAME", "ORIGIN_STATE_ABR", "ORIGIN_COUNTRY", "DEST", "DEST_COUNTRY",
  "AIRCRAFT_CONFIG", "YEAR", "MONTH", "CLASS",
];

export function t100CachePath(year) {
  return `${CACHE_DIR}/t100_segment_all_carriers_${year}.zip`;
}

function hiddenFields(html) {
  const fields = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = m[0].match(/name="([^"]+)"/)?.[1];
    const value = m[0].match(/value="([^"]*)"/)?.[1] ?? "";
    if (name) fields[name] = value;
  }
  return fields;
}

export function buildPostBody(hidden, year) {
  const body = new URLSearchParams({ ...hidden, cboGeography: "All", cboYear: String(year), cboPeriod: "All", btnDownload: "Download" });
  for (const column of T100_COLUMNS) body.set(column, "on");
  return body;
}

export async function fetchT100Year(year) {
  const target = t100CachePath(year);
  const cached = await stat(target).catch(() => null);
  if (cached) return { path: target, bytes: cached.size, fromCache: true };

  const getResponse = await fetch(FORM_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!getResponse.ok) fail(`T-100 form GET returned ${getResponse.status}`);
  const cookies = (getResponse.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const hidden = hiddenFields(await getResponse.text());
  if (!hidden.__VIEWSTATE || !hidden.__EVENTVALIDATION) fail("T-100 form has no __VIEWSTATE/__EVENTVALIDATION; BTS changed the page");

  const postResponse = await fetch(FORM_URL, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies, Referer: FORM_URL },
    body: buildPostBody(hidden, year),
  });
  const type = postResponse.headers.get("content-type") ?? "";
  if (!postResponse.ok || !/zip|octet/i.test(type)) {
    fail(`T-100 POST did not return a zip (status ${postResponse.status}, type ${type}); use the manual path`);
  }
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(target, Buffer.from(await postResponse.arrayBuffer()));
  return { path: target, bytes: (await stat(target)).size, fromCache: false, sha256: await sha256OfFile(target) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const year = Number(process.argv[2]);
  if (!Number.isInteger(year)) fail("usage: node fetch-t100.mjs <year>");
  console.log(await fetchT100Year(year));
}
