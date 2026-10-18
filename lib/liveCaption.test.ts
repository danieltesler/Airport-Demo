/**
 * Table formatting and provenance labels built by code: load factor as a one-decimal percentage
 * everywhere, and a caption plus data-vintage footer that say where a live figure came from.
 * No network: fetch and the OpenAI client are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLiveCaches } from "./live/common";
import { fixture } from "./live/testing";

const { scripted, createMock } = vi.hoisted(() => {
  const queue: unknown[] = [];
  return { scripted: queue, createMock: vi.fn(async () => ({ choices: [{ message: queue.shift() }] })) };
});
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

import * as data from "./data";
import { runAgent } from "./agent";
import { liveCaption, vintageFooter } from "./i18n";
import { percentText, percentValue } from "./percent";
import { toSpokenSummary } from "./spoken";
import { compareAirports, rankAirports, runTool } from "./tools";

const toolCall = (name: string, args: object) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const finalText = (content: string) => ({ role: "assistant", content });

function stubFetch(routes: [string, { status?: number; body?: string }][]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const hit = routes.find(([needle]) => String(input).includes(needle));
      if (!hit) throw new Error(`Unmocked network call: ${String(input)}`);
      return new Response(hit[1].body ?? "", { status: hit[1].status ?? 200 });
    }),
  );
}

type Call = [{ messages: { role: string; content: string }[] }];
const toolMessage = (callIndex: number): string =>
  (createMock.mock.calls[callIndex] as unknown as Call)[0].messages.find((m) => m.role === "tool")!.content;

beforeEach(() => {
  clearLiveCaches();
  scripted.length = 0;
  createMock.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("load factor as a percentage", () => {
  it("rounds half up to one decimal and never shows a lossy ratio", () => {
    expect(percentText(0.7985)).toBe("79.9%"); // the SNA case: shown as 0.8 before
    expect(percentText(0.817)).toBe("81.7%");
    expect(percentText(0.8)).toBe("80.0%");
    expect(percentText(0.82)).toBe("82.0%");
    expect(percentText(null)).toBeNull();
    expect(percentValue(0.7985)).toBe(79.9);
  });

  it("is the same text in the ranking and comparison tables, and in the figure the model reads", () => {
    const sna = data.getAirport("SNA")!;
    const expected = percentText(sna.load_factor)!;
    const comparison = compareAirports(["LAX", "SNA"], "congestion");
    const loadColumn = comparison.structured!.columns.indexOf("Load factor");
    const snaRow = comparison.structured!.rows.find((r) => String(r[0]).startsWith("SNA"))!;
    expect(snaRow[loadColumn]).toBe(expected);
    expect(expected).toMatch(/^\d+\.\d%$/);
    const modelFigure = (comparison.result.comparison as { iata: string; load_factor_pct: number }[]).find((c) => c.iata === "SNA")!;
    expect(`${modelFigure.load_factor_pct.toFixed(1)}%`).toBe(expected);

    const ranking = rankAirports("California", "expansion", 20);
    const rankColumn = ranking.structured!.columns.indexOf("Load factor");
    for (const row of ranking.structured!.rows) expect(row[rankColumn]).toMatch(/^\d+\.\d%$/);
  });

  it("shows n/a, not a number, when the source value is suppressed", () => {
    const airport = data.getAirport("SNA")!;
    const saved = airport.load_factor;
    airport.load_factor = null;
    try {
      const out = compareAirports(["SNA"], "congestion");
      expect(out.structured!.rows[0][out.structured!.columns.indexOf("Load factor")]).toBe("n/a");
    } finally {
      airport.load_factor = saved;
    }
  });

  it("leaves the spoken summary consistent with the table: no load factor read, same growth figure", () => {
    const ranking = rankAirports("New England", "expansion", 3);
    const spoken = toSpokenSummary(ranking.structured, ranking.uncertainty)!;
    expect(spoken).not.toMatch(/load/i);
    const growthCell = String(ranking.structured!.rows[0][ranking.structured!.columns.indexOf("Growth YoY")]);
    const growth = Math.abs(parseFloat(growthCell));
    if (spoken.includes("YoY")) expect(spoken).toContain(String(Number(growth.toFixed(2))));
  });

  it("formats the live BTS load factor the same way", async () => {
    stubFetch([["data.bts.gov", { body: fixture("bts-t100-bos.real.json") }]]);
    const out = await runTool("bts_airport_traffic", { iata: "BOS" });
    const row = out.structured!.rows.find((r) => r[0] === "Load factor")!;
    expect(row[1]).toMatch(/^\d+\.\d%$/);
    const trailing = out.result.trailing_12_months as { load_factor: number; load_factor_pct: number };
    expect(row[1]).toBe(`${trailing.load_factor_pct.toFixed(1)}%`);
  });
});

describe("live caption and data-vintage footer", () => {
  it("builds the caption from the source name and retrieval time", () => {
    expect(liveCaption("FAA NAS Status", "2026-10-18T14:32:07.123Z")).toBe("Source: FAA NAS Status · retrieved 14:32 UTC");
  });

  it("gives a live tool table a code-owned caption that stays out of the model's context", async () => {
    stubFetch([["nasstatus.faa.gov", { body: fixture("faa-nas-status.real.xml") }]]);
    const out = await runTool("faa_airport_status", { iata: "SAN" });
    const retrieved = new Date(out.result.retrieved_at as string);
    const hhmm = retrieved.toISOString().slice(11, 16);
    expect(out.structured?.caption).toBe(`Source: FAA NAS Status · retrieved ${hhmm} UTC`);
    expect(out.live).toEqual({ source: "FAA NAS Status", retrievedAt: out.result.retrieved_at });
    expect(JSON.stringify(out.result)).not.toContain(out.structured!.caption!);
    expect(JSON.stringify(out.result)).not.toContain('"live"');
  });

  it("captions every live tool that returns a table", async () => {
    stubFetch([
      ["aviationweather.gov", { body: fixture("metar-kjfk.real.json") }],
      ["data.bts.gov", { body: fixture("bts-t100-bos.real.json") }],
    ]);
    for (const [tool, iata, source] of [
      ["airport_weather", "JFK", "NOAA Aviation Weather Center"],
      ["bts_airport_traffic", "BOS", "BTS T-100 (data.bts.gov)"],
    ] as const) {
      const out = await runTool(tool, { iata });
      expect(out.structured?.caption).toMatch(new RegExp(`^Source: ${source.replace(/[().]/g, "\\$&")} · retrieved \\d\\d:\\d\\d UTC$`));
    }
  });

  it("adds no caption or source for a failed live call", async () => {
    stubFetch([["nasstatus.faa.gov", { status: 503 }]]);
    const out = await runTool("faa_airport_status", { iata: "BOS" });
    expect(out.structured ?? null).toBeNull();
    expect(out.live).toBeUndefined();
  });

  it("footer: a live-only turn says 'Live data', not the dataset vintage", async () => {
    stubFetch([["nasstatus.faa.gov", { body: fixture("faa-nas-status.real.xml") }]]);
    scripted.push(toolCall("faa_airport_status", { iata: "SAN" }), finalText("done"));
    const res = await runAgent("Any delays at SAN right now?");
    expect(res.meta?.data_vintage).toMatch(/^Live data: FAA NAS Status · retrieved \d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
    expect(res.meta?.data_vintage).not.toMatch(/Calendar year|BTS T-100 Segment/);
    expect(res.structured?.caption).toMatch(/^Source: FAA NAS Status · retrieved \d\d:\d\d UTC$/);
    expect(toolMessage(1)).not.toContain("Source: FAA NAS Status");
  });

  it("footer: a dataset-only turn keeps the dataset vintage", async () => {
    scripted.push(toolCall("airport_profile", { iata: "BOS" }), finalText("done"));
    const res = await runAgent("Tell me about BOS");
    expect(res.meta?.data_vintage).toBe(data.dataVintage());
  });

  it("footer: a mixed turn shows both, labelled", async () => {
    stubFetch([["nasstatus.faa.gov", { body: fixture("faa-nas-status.real.xml") }]]);
    scripted.push(toolCall("rank_airports", { scope: "all", metric: "expansion" }), toolCall("faa_airport_status", { iata: "SAN" }), finalText("done"));
    const res = await runAgent("Rank airports, then SAN delays.");
    expect(res.meta?.data_vintage).toBe(
      `Dataset: ${data.dataVintage()} | Live data: ${res.meta!.data_vintage!.split("Live data: ")[1]}`,
    );
    expect(res.meta?.data_vintage).toMatch(/\| Live data: FAA NAS Status · retrieved /);
    expect(res.structured?.kind).toBe("ranking"); // the ranking table is not replaced by the live one
  });

  it("footer: a live-only turn whose source failed shows no vintage line at all", async () => {
    stubFetch([["nasstatus.faa.gov", { status: 503 }]]);
    scripted.push(toolCall("faa_airport_status", { iata: "BOS" }), finalText("unavailable"));
    const res = await runAgent("Any delays at BOS?");
    expect(res.meta?.data_vintage).toBeUndefined();
  });

  it("vintageFooter lists several live sources", () => {
    const text = vintageFooter({
      datasetVintage: "V",
      usedDataset: false,
      usedLive: true,
      live: [
        { source: "A", retrievedAt: "2026-10-18T14:32:00.000Z" },
        { source: "B", retrievedAt: "2026-10-18T14:33:00.000Z" },
      ],
    });
    expect(text).toBe("Live data: A · retrieved 2026-10-18 14:32 UTC; B · retrieved 2026-10-18 14:33 UTC");
  });
});
