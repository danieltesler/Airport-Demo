/**
 * Integration of the live tools with the app: registration in TOOL_SCHEMAS, the runTool
 * dispatch path, the OpenAI tool format, and the agent loop with a scripted model.
 * No network: global fetch and the OpenAI client are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLiveCaches } from "./common";
import { LIVE_TOOLS } from "./index";
import { fixture } from "./testing";

// Scripted model: each create() call returns the next queued message.
const { scripted, createMock } = vi.hoisted(() => {
  const queue: unknown[] = [];
  return { scripted: queue, createMock: vi.fn(async () => ({ choices: [{ message: queue.shift() }] })) };
});
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

import { runAgent } from "../agent";
import { TOOL_SCHEMAS, runTool } from "../tools";

const toolCall = (name: string, args: object) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const finalText = (content: string) => ({ role: "assistant", content });

function stubFetch(routes: [string, { status?: number; body?: string }][]) {
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const hit = routes.find(([needle]) => url.includes(needle));
    if (!hit) throw new Error(`Unmocked network call: ${url}`);
    return new Response(hit[1].body ?? "", { status: hit[1].status ?? 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  clearLiveCaches();
  scripted.length = 0;
  createMock.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("registration", () => {
  it("adds every live tool to TOOL_SCHEMAS with unique names", () => {
    const names = TOOL_SCHEMAS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of LIVE_TOOLS) expect(names).toContain(tool.name);
    expect(names).toContain("live_flights"); // existing tools are untouched
    expect(names).toContain("rank_airports");
  });

  it("produces valid OpenAI function-tool definitions", () => {
    for (const t of TOOL_SCHEMAS) {
      const def = { type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } };
      expect(def.function.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/); // OpenAI's name rule
      expect(def.function.description.length).toBeGreaterThan(20);
      expect(def.function.parameters).toMatchObject({ type: "object" });
      const params = def.function.parameters as { properties: Record<string, unknown>; required?: string[] };
      for (const key of params.required ?? []) expect(params.properties).toHaveProperty(key);
      expect(() => JSON.stringify(def)).not.toThrow();
    }
  });
});

describe("runTool dispatch", () => {
  it("routes a live tool through the live registry", async () => {
    const fetchFn = stubFetch([["nasstatus.faa.gov", { body: fixture("faa-nas-status.real.xml") }]]);
    const out = await runTool("faa_airport_status", { iata: "SAN" });
    expect(out.result).toMatchObject({ available: true, iata: "SAN", status: "faa_program_reported" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("still routes dataset tools and rejects unknown names", async () => {
    expect((await runTool("airport_profile", { iata: "BOS" })).result.iata).toBe("BOS");
    expect((await runTool("no_such_tool", {})).result.error).toMatch(/Unknown tool/);
  });

  it("keeps live-tool failures honest: available=false plus a fallback instruction", async () => {
    stubFetch([["nasstatus.faa.gov", { status: 500 }]]);
    const out = await runTool("faa_airport_status", { iata: "BOS" });
    expect(out.result).toMatchObject({ available: false });
    expect(String(out.result.fallback)).toMatch(/unavailable/i);
    expect(String(out.result.fallback)).toMatch(/Do not estimate/);
  });

  it("states how live BTS traffic relates to the dataset snapshot without changing it", async () => {
    stubFetch([["data.bts.gov", { body: fixture("bts-t100-bos.real.json") }]]);
    const out = await runTool("bts_airport_traffic", { iata: "BOS" });
    const note = out.result.bundled_dataset as Record<string, unknown>;
    expect(note.annual_passengers).toBeGreaterThan(0);
    expect(note.dataset_vintage).toBeTruthy();
    expect(typeof note.differs_materially).toBe("boolean");
    expect(String(note.explanation)).toMatch(/dataset/);
    // Like for like (both domestic + international): the live trailing 12 months and the
    // dataset's calendar 2025 agree within a few percent. Comparing the live DOMESTIC figure
    // instead would show a false 20%+ gap at BOS.
    expect(Math.abs(note.live_vs_dataset as number)).toBeLessThan(0.05);
    // The dataset-backed profile is unaffected by the live call.
    const profile = await runTool("airport_profile", { iata: "BOS" });
    expect((profile.result.metrics as Record<string, number>).annual_passengers).toBe(note.annual_passengers);
  });
});

describe("agent loop with a mocked model", () => {
  it("answers a live question from the tool result and surfaces its metric table", async () => {
    stubFetch([["nasstatus.faa.gov", { body: fixture("faa-nas-status.real.xml") }]]);
    scripted.push(toolCall("faa_airport_status", { iata: "SAN" }), finalText("SAN has a ground delay program."));
    const res = await runAgent("Any delays at SAN right now?");
    expect(res.reply).toBe("SAN has a ground delay program.");
    expect(res.meta?.tools_used).toEqual(["faa_airport_status"]);
    expect(res.structured?.kind).toBe("metric");
    expect(res.structured?.columns[0]).toMatch(/FAA status/);
    expect(res.uncertainty).toMatch(/not 'no delays'/);

    // The tool message the model saw carries the source and retrieval time.
    const toolMsg = (createMock.mock.calls[1] as unknown as [{ messages: { role: string; content: string }[] }])[0].messages.find(
      (m) => m.role === "tool",
    )!;
    expect(JSON.parse(toolMsg.content)).toMatchObject({ source: expect.stringContaining("FAA"), retrieved_at: expect.any(String) });
  });

  it("does not let a live metric table replace a ranking table from the same turn", async () => {
    stubFetch([["aviationweather.gov", { body: fixture("metar-kjfk.real.json") }]]);
    scripted.push(
      toolCall("rank_airports", { scope: "all", metric: "expansion", user_words: "all" }),
      toolCall("airport_weather", { iata: "JFK" }),
      finalText("done"),
    );
    const res = await runAgent("Rank the airports, then give JFK weather.");
    expect(res.meta?.tools_used).toEqual(["rank_airports", "airport_weather"]);
    expect(res.structured?.kind).toBe("ranking");
  });

  it("a failed live source reaches the model as available=false and adds no structured table", async () => {
    stubFetch([["nasstatus.faa.gov", { status: 503 }]]);
    scripted.push(toolCall("faa_airport_status", { iata: "BOS" }), finalText("The live FAA feed is unavailable."));
    const res = await runAgent("Any delays at BOS?");
    expect(res.structured).toBeNull();
    const toolMsg = (createMock.mock.calls[1] as unknown as [{ messages: { role: string; content: string }[] }])[0].messages.find(
      (m) => m.role === "tool",
    )!;
    expect(JSON.parse(toolMsg.content)).toMatchObject({ available: false });
  });

  it("system prompt tells the model when to use live tools and to cite sources", async () => {
    scripted.push(finalText("hi"));
    await runAgent("hello");
    const first = (createMock.mock.calls[0] as unknown as [{ messages: { role: string; content: string }[] }])[0];
    const system = first.messages[0].content;
    for (const name of ["faa_airport_status", "airport_weather", "bts_airport_traffic", "faa_airport_infrastructure"]) {
      expect(system).toContain(name);
    }
    expect(system).toMatch(/retrieval time/);
    expect(system).toMatch(/never invent a live value/);
    expect(system).toMatch(/user_words/); // existing scope rules preserved
  });
});

describe("the tool list the model sees", () => {
  it("has no population tool, and 14 tools of which 5 are live", () => {
    const names = TOOL_SCHEMAS.map((tool) => tool.name);
    expect(names).not.toContain("metro_population");
    expect(names).toHaveLength(14);
    expect(names.filter((name) => LIVE_TOOLS.some((tool) => tool.name === name) || name === "live_flights")).toHaveLength(5);
  });
});
